/**
 * TPS 配置：类型、默认值、校验与 settings.json 读写（"tokenSpeed" 键）。
 * 合并自 pi-token-speed 的 config-types / defaults / validation / settings。
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 显示模式 —— 状态栏中展示的信息详细程度 */
export type DisplayMode = "tps" | "ttft" | "stats" | "full";

/** 计数策略 —— 流式期间如何统计 token */
export type CountStrategy = "estimate" | "direct";

/** 流结束后的 TPS 展示行为 */
export type EndTpsBehavior = "average" | "last";

export interface TokenSpeedConfig {
	display: DisplayMode;
	slidingWindow: number;
	useProviderTokens: boolean;
	countStrategy: CountStrategy;
	endTpsBehavior: EndTpsBehavior;
}

/** settings.json 中的配置块键名 */
const SETTINGS_KEY = "tokenSpeed";

// ---- 默认值 ----
const DEFAULTS: TokenSpeedConfig = {
	display: "tps",
	slidingWindow: 1000,
	useProviderTokens: false,
	countStrategy: "direct",
	endTpsBehavior: "average",
};

/** 滑动窗口合法范围（ms）：100ms 是最小有意义窗口，30s 是最大实用窗口 */
export const MIN_SLIDING_WINDOW = 100;
export const MAX_SLIDING_WINDOW = 30000;

const DISPLAY_MODES: readonly string[] = ["tps", "ttft", "stats", "full"];
const COUNT_STRATEGIES: readonly string[] = ["estimate", "direct"];
const END_TPS_BEHAVIORS: readonly string[] = ["average", "last"];

/**
 * 校验配置：可纠正的非法值回退默认值，全部问题收集为错误信息
 * （会话开始时在状态栏弹 warning）。
 */
export function validateConfig(config: TokenSpeedConfig): { config: TokenSpeedConfig; errors: string[] } {
	const response = { ...config };
	const errors: string[] = [];

	if (!DISPLAY_MODES.includes(response.display)) {
		errors.push(`- Invalid display "${response.display}" — defaulting to "${DEFAULTS.display}".`);
		response.display = DEFAULTS.display;
	}
	if (!COUNT_STRATEGIES.includes(response.countStrategy)) {
		errors.push(`- Invalid countStrategy "${response.countStrategy}" — defaulting to "${DEFAULTS.countStrategy}".`);
		response.countStrategy = DEFAULTS.countStrategy;
	}
	if (!END_TPS_BEHAVIORS.includes(response.endTpsBehavior)) {
		errors.push(`- Invalid endTpsBehavior "${response.endTpsBehavior}" — defaulting to "${DEFAULTS.endTpsBehavior}".`);
		response.endTpsBehavior = DEFAULTS.endTpsBehavior;
	}
	if (typeof response.useProviderTokens !== "boolean") {
		errors.push(`- Invalid useProviderTokens (expected boolean) — defaulting to ${DEFAULTS.useProviderTokens}.`);
		response.useProviderTokens = DEFAULTS.useProviderTokens;
	}
	if (
		typeof response.slidingWindow !== "number" ||
		response.slidingWindow < MIN_SLIDING_WINDOW ||
		response.slidingWindow > MAX_SLIDING_WINDOW
	) {
		errors.push(`- Invalid slidingWindow "${response.slidingWindow}" — defaulting to ${DEFAULTS.slidingWindow}.`);
		response.slidingWindow = DEFAULTS.slidingWindow;
	}

	return { config: response, errors };
}

/**
 * tokenSpeed 配置的读取、校验、缓存与持久化。
 * 使用导出的 tpsSettings 单例，不要直接实例化。
 */
export class TpsSettings {
	private cachedConfig: TokenSpeedConfig | null = null;
	private cachedErrors: string[] = [];

	constructor(private readonly settingsPath = join(getAgentDir(), "settings.json")) {}

	getDefaultConfig(): TokenSpeedConfig {
		return { ...DEFAULTS };
	}

	/** 读取用户配置、合并默认值、校验并缓存 */
	async initialize(): Promise<TokenSpeedConfig> {
		const userSettings = await this.readUserSettings();
		const merged = { ...DEFAULTS, ...userSettings };
		const { config, errors } = validateConfig(merged);
		this.cachedConfig = config;
		this.cachedErrors = errors;
		return config;
	}

	/** 返回缓存配置；未初始化时返回默认值 */
	getConfig(): TokenSpeedConfig {
		return this.cachedConfig || this.getDefaultConfig();
	}

	/** 上次初始化时的校验错误（用于启动警告） */
	getErrors(): string[] {
		return this.cachedErrors;
	}

	/** 写入部分配置到 settings.json 并更新缓存 */
	async setConfig(partial: Partial<TokenSpeedConfig>): Promise<void> {
		const settings = await this.readSettingsFile();
		const current = (settings[SETTINGS_KEY] as Record<string, unknown>) || {};
		settings[SETTINGS_KEY] = { ...current, ...partial };
		await writeFile(this.settingsPath, JSON.stringify(settings, null, 2), "utf-8");
		this.cachedConfig = { ...this.getConfig(), ...partial };
	}

	private async readSettingsFile(): Promise<Record<string, unknown>> {
		try {
			const raw = await readFile(this.settingsPath, "utf-8");
			return JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	private async readUserSettings(): Promise<Partial<TokenSpeedConfig>> {
		const settings = await this.readSettingsFile();
		return (settings[SETTINGS_KEY] || {}) as Partial<TokenSpeedConfig>;
	}
}

/** 共享单例 */
export const tpsSettings = new TpsSettings();
