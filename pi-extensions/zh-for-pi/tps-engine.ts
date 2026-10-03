/**
 * TPS 测量引擎 + 时间滑动窗口。
 * 合并自 pi-token-speed 的 engine / sliding-window / constants。
 */

import { tpsSettings, type CountStrategy, type EndTpsBehavior } from "./tps-config";

/** 会产生 token 输出的工具（其余工具视为提示词处理，不计入且暂停计时） */
export const TOKEN_GENERATION_TOOLS = new Set(["edit", "write"]);

/** 滑动窗口死记录达到该数量时压缩数组，防止内存膨胀 */
const COMPACTION_THRESHOLD = 5000;

/** 计算 TPS 时的最小时间跨度（ms），防止瞬时尖峰 */
const MIN_WINDOW_SPAN = 100;

const TOKEN_REGEX = /\w+|[^\s\w]/g;

/**
 * 基于时间的滑动窗口：记录带时间戳的 token 事件，
 * 只统计最近 windowMs 内的事件来计算 TPS。
 */
class SlidingWindow {
	private readonly events: { time: number; tokens: number }[] = [];
	private windowStartIndex = 0;

	constructor(private readonly windowMs: number) {}

	record(tokens: number): void {
		this.events.push({ time: Date.now(), tokens });
		if (this.windowStartIndex >= COMPACTION_THRESHOLD) {
			this.compact();
		}
	}

	getTps(now: number): number {
		if (this.events.length === 0) return 0;

		const windowStart = now - this.windowMs;

		// 跳过窗口之外的旧事件
		while (this.windowStartIndex < this.events.length && this.events[this.windowStartIndex].time < windowStart) {
			this.windowStartIndex++;
		}

		if (this.windowStartIndex >= this.events.length) return 0;

		let windowTokenCount = 0;
		for (let i = this.windowStartIndex; i < this.events.length; i++) {
			windowTokenCount += this.events[i].tokens;
		}

		if (windowTokenCount === 0) return 0;

		// 用实际跨度，但钳制最小值防止突发尖峰
		const rawSpan = now - this.events[this.windowStartIndex].time;
		const span = Math.max(rawSpan, MIN_WINDOW_SPAN);
		return (1000 * windowTokenCount) / span;
	}

	private compact(): void {
		if (this.windowStartIndex === 0) return;
		this.events.splice(0, this.windowStartIndex);
		this.windowStartIndex = 0;
	}

	reset(): void {
		this.events.length = 0;
		this.windowStartIndex = 0;
	}
}

/**
 * Token 速度测量引擎。
 *
 * 计数行为：
 * - 优先使用服务商上报的 output token 数（useProviderTokens 开启且可用时）
 * - 否则按 countStrategy：direct 每个 delta 记 1 token；estimate 用正则按词边界估算
 * - 只有 edit/write 工具调用计入；其他工具（提示词处理）在 toolcall_end 时暂停计时
 */
export class TokenSpeedEngine {
	private _isStreaming = false;
	private _isPaused = false;

	private _tokenCount = 0;
	private _startTime = 0;
	private _endTime = 0;

	private _ttftStart = 0;
	private _ttftEnd = 0;

	private _startPause = 0;
	private _pausedMs = 0;

	private _tps = 0;
	private _countedUsageOutput = 0;

	private _slidingWindow!: SlidingWindow;
	private _useProviderTokens!: boolean;
	private _countStrategy!: CountStrategy;
	private _endTpsBehavior!: EndTpsBehavior;

	/** 加载配置。必须在 tpsSettings.initialize() 之后调用 */
	initialize(): void {
		const config = tpsSettings.getConfig();
		this._slidingWindow = new SlidingWindow(config.slidingWindow);
		this._countStrategy = config.countStrategy;
		this._useProviderTokens = config.useProviderTokens;
		this._endTpsBehavior = config.endTpsBehavior;
	}

	/**
	 * 记录一次流式 delta。
	 * @param delta 文本/思考 delta 字符串
	 * @param usageOutput 服务商上报的累计 output token 数（可选）
	 */
	recordDelta(delta: string, usageOutput?: number): void {
		if (!this._isStreaming) return;
		if (this._isPaused) this.resume();

		const shouldUseProviderTokens =
			this._useProviderTokens && usageOutput !== undefined && usageOutput > this._countedUsageOutput;

		if (shouldUseProviderTokens) {
			this.recordTokens(usageOutput - this._countedUsageOutput);
			this._countedUsageOutput = usageOutput;
			return;
		}

		if (this._countStrategy === "estimate") {
			this.recordTokens(this.estimateTokens(delta));
		} else {
			this.recordTokens(1);
		}
	}

	/** 用权威 usage 校准总数，保证最终平均值精确 */
	reconcileTotal(tokens: number): void {
		if (tokens > 0) this._tokenCount = tokens;
	}

	get isStreaming() {
		return this._isStreaming;
	}

	get tokenCount() {
		return this._tokenCount;
	}

	/** 流开始以来的毫秒数（扣除暂停时长；未开始为 0） */
	get elapsedMs(): number {
		if (this._startTime === 0) return 0;
		if (this.isStreaming) return Date.now() - this._startTime - this._pausedMs;
		return this._endTime - this._startTime - this._pausedMs;
	}

	get elapsedSeconds(): number {
		return this.elapsedMs / 1000;
	}

	/**
	 * 流式中返回滑动窗口 TPS；结束后按 endTpsBehavior：
	 * "average"（默认）返回全程平均值；"last" 返回最后一个窗口测量值。
	 */
	get tps(): number {
		if (this._isStreaming) return this._tps;
		if (this._endTpsBehavior === "last") return this._tps;
		return this.tpsAvg;
	}

	/** 全程平均 TPS = 总 token / 总耗时秒数 */
	get tpsAvg(): number {
		if (this.elapsedSeconds <= 0) return 0;
		return this._tokenCount / this.elapsedSeconds;
	}

	/** 首 token 延迟（ms） */
	get ttft(): number {
		return Math.max(this._ttftEnd - this._ttftStart, 0);
	}

	/** 开始一次新的流式会话 */
	start(): void {
		if (this._isStreaming) return;

		this._tokenCount = 0;
		this._isStreaming = true;
		this._startTime = Date.now();
		this._endTime = Date.now();
		this._slidingWindow.reset();
		this._countedUsageOutput = 0;
		this._tps = 0;
		this._pausedMs = 0;
	}

	/** 记录 TTFT 起始时间戳 */
	startTTFT(): void {
		this._ttftStart = Date.now();
		this._ttftEnd = 0;
	}

	/** 记录 TTFT 结束时间戳（每次流只捕获一次） */
	stopTTFT(): void {
		if (this._ttftEnd !== 0) return;
		this._ttftEnd = Date.now();
	}

	/** 停止流式 */
	stop(): void {
		this._isStreaming = false;
		this._endTime = Date.now();
		this._slidingWindow.reset();
	}

	/** 暂停计时（非 edit/write 工具调用结束时调用）；下一个 recordDelta 会自动恢复 */
	pause(): void {
		this._isPaused = true;
		this._startPause = Date.now();
	}

	private resume(): void {
		this._isPaused = false;
		this._pausedMs += Date.now() - this._startPause;
	}

	private recordTokens(tokens: number): void {
		if (!this._isStreaming || tokens <= 0) return;

		this._tokenCount += tokens;
		this._slidingWindow.record(tokens);
		this._tps = this._slidingWindow.getTps(Date.now());
	}

	private estimateTokens(text: string): number {
		if (!text) return 0;
		const matches = text.match(TOKEN_REGEX);
		return matches ? matches.length : 0;
	}
}
