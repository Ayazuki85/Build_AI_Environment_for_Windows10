/**
 * zh-for-pi — 中文 footer（含 TPS 实时速度）
 *
 * 复刻默认 pi footer，但隐藏 cost（`$0.471 (sub)`）与服务商前缀，
 * stats 行使用中文字段，始终显示全部字段；模型名 + 思考等级固定在第三行
 * 右对齐，扩展状态（ctx.ui.setStatus，如 DS余额）与模型同行、靠左拼接；
 * 例外："计划模式"状态（key 为 plan-mode）右对齐到第一行 cwd 行：
 *   ~/src/proj                                                              计划模式
 *   输入:21k 输出:3.5k 缓存命中率:98.9% TPS:33.0t/s 上下文使用百分比:1.8%/1.0M
 *   DS余额 ¥164.14                                              deepseek-flash • max
 *
 * 思考等级文字按等级着色（theme.getThinkingBorderColor），编辑器边框固定为
 * 主题默认灰（bash 模式 "!" 前缀输入仍为绿色）。
 *
 * TPS 功能合并自 pi-token-speed（MIT，作者 Gabriel Sanhueza）：
 * 实时 TPS（滑动窗口）、TTFT，配置读取 settings.json 的
 * "tokenSpeed" 块，/tps 命令打开设置菜单。与原版差异：不再用 setStatus
 * 单独占一行，而是直接拼进 footer 的 stats 行；单位显示为 "t/s"；
 * 不做按速度分档着色，TPS 数字与其他字段同为 dim。
 * 另外 stats 行各字段单独包 dim（而非整行统一包），否则上下文百分比的
 * error/warning 颜色码 \x1b[0m 复位会冲掉外层 dim。
 *
 * 要恢复默认 footer：删除 index.ts 中的 installFooterFeature(pi) 调用后重启 pi。
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type AgentEndEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { TpsCommand } from "./tps-command.ts";
import { tpsSettings, type DisplayMode } from "./tps-config.ts";
import { TOKEN_GENERATION_TOOLS, TokenSpeedEngine } from "./tps-engine.ts";

/** Same compact formatting as the default footer. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Replace home directory prefix with ~ (same as default footer). */
function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Bash-mode border color captured from the app Theme (fallback: ANSI green). */
let bashBorderColor: ((str: string) => string) | undefined;

/**
 * Editor with a fixed gray border. The app normally recolors the border by
 * thinking level (updateEditorBorderColor); this subclass ignores those
 * attempts via a no-op setter and always returns the theme's default border
 * color — except for bash mode ("!"-prefixed input), which keeps green.
 */
class FixedBorderEditor extends CustomEditor {
	constructor(...args: ConstructorParameters<typeof CustomEditor>) {
		super(...args);
		const [, editorTheme] = args;
		const gray = editorTheme.borderColor ?? ((str: string) => str);
		const fallbackGreen = (str: string) => `\x1b[32m${str}\x1b[39m`;
		Object.defineProperty(this, "borderColor", {
			get: () => (this.getText().trimStart().startsWith("!") ? (bashBorderColor ?? fallbackGreen) : gray),
			set: () => {}, // ignore app attempts to recolor the border by thinking level
			configurable: true,
		});
	}
}

// ---------------------------------------------------------------------------
// TPS（合并自 pi-token-speed）
// ---------------------------------------------------------------------------

/** TPS 测量引擎（模块级单例，footer 渲染时读取） */
const tpsEngine = new TokenSpeedEngine();

/** footer 工厂捕获的 TUI 引用，用于在流式事件时请求重绘 */
let tuiRef: { requestRender(): void } | undefined;

/** footer 主题的最小结构类型（只需 fg） */
interface FooterThemeLike {
	fg(color: string, text: string): string;
}

/** TPS 数值之后的后缀（TTFT / 统计信息），按显示模式 */
function buildTpsSuffix(display: DisplayMode): string {
	const { ttft, tokenCount, elapsedSeconds } = tpsEngine;
	const stats =
		elapsedSeconds > 0 ? `${tokenCount} tokens in ${elapsedSeconds.toFixed(1)}s` : `${tokenCount} tokens`;

	switch (display) {
		case "tps":
			return "";
		case "ttft":
			return ` (TTFT: ${ttft} ms)`;
		case "stats":
			return ` (${stats})`;
		case "full":
			return ` (${stats} · TTFT: ${ttft} ms)`;
	}
}

/**
 * 构建 footer stats 行中的 TPS 段：
 *   TPS:33.0t/s
 * 未产生过流式数据时显示 "TPS:--"。数字不着色，与其他字段同为 dim。
 */
function buildTpsSegment(theme: FooterThemeLike): string {
	const hasData = tpsEngine.isStreaming || tpsEngine.tokenCount > 0 || tpsEngine.elapsedMs > 0;
	if (!hasData) return theme.fg("dim", "TPS:--");

	const suffix = buildTpsSuffix(tpsSettings.getConfig().display);
	return theme.fg("dim", `TPS:${tpsEngine.tps.toFixed(1)}t/s${suffix}`);
}

// ---- TPS 事件处理（移植自 pi-token-speed 的 events.ts） ----

interface TpsToolCall {
	type: string;
	name?: string;
}

interface TpsMessageUpdatePayload {
	assistantMessageEvent: {
		type: string;
		delta?: string;
		partial?: {
			content?: TpsToolCall[];
			usage?: { output?: number };
		};
		contentIndex?: number;
	};
}

function handleTpsMessageUpdate(event: TpsMessageUpdatePayload): void {
	const ev = event.assistantMessageEvent;

	if (ev.type === "text_start" || ev.type === "thinking_start" || ev.type === "toolcall_start") {
		tpsEngine.stopTTFT();
		tpsEngine.start();
		return;
	}

	if (ev.type === "text_delta" || ev.type === "thinking_delta") {
		tpsEngine.recordDelta(ev.delta ?? "", ev.partial?.usage?.output);
		tuiRef?.requestRender();
		return;
	}

	if (ev.type === "toolcall_delta") {
		const toolCall = ev.partial?.content?.[ev.contentIndex ?? 0];
		if (toolCall?.type !== "toolCall") return;

		// 只有 edit/write 工具计入 token 生成
		if (TOKEN_GENERATION_TOOLS.has(toolCall.name ?? "")) {
			tpsEngine.recordDelta(ev.delta ?? "", ev.partial?.usage?.output);
			tuiRef?.requestRender();
		}
	}

	if (ev.type === "toolcall_end") {
		const toolCall = ev.partial?.content?.[ev.contentIndex ?? 0];
		if (toolCall?.type !== "toolCall") return;

		// 提示词处理类工具暂停计时，避免拉低 TPS
		if (!TOKEN_GENERATION_TOOLS.has(toolCall.name ?? "")) {
			tpsEngine.pause();
		}
	}
}

function handleTpsAgentEnd(event: AgentEndEvent): void {
	tpsEngine.stop();

	// 只有 assistant 和 toolResult 消息携带 usage 数据
	const outputTokens = event.messages.reduce((acc, curr) => {
		if (curr.role === "assistant") {
			return acc + curr.usage.output;
		}
		if (curr.role === "toolResult") {
			return acc + (curr.usage?.output ?? 0);
		}
		return acc;
	}, 0);

	tpsEngine.reconcileTotal(outputTokens);
	tuiRef?.requestRender();
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function installFooter(ctx: ExtensionContext) {
	ctx.ui.setFooter((tui, theme, footerData) => {
		tuiRef = tui;
		return {
			invalidate() {},
			dispose: footerData.onBranchChange(() => tui.requestRender()),
			render(width: number): string[] {
				// Capture the real bash-mode color from the app theme for FixedBorderEditor
				bashBorderColor = theme.getBashModeBorderColor();

				// ---- Usage totals over ALL session entries (same as default footer) ----
				let input = 0;
				let output = 0;
				let cacheRead = 0;
				let cacheWrite = 0;
				let latestCacheHitRate: number | undefined;

				for (const entry of ctx.sessionManager.getEntries()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const m = entry.message as AssistantMessage;
						input += m.usage.input;
						output += m.usage.output;
						cacheRead += m.usage.cacheRead;
						cacheWrite += m.usage.cacheWrite;

						const promptTokens = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
						latestCacheHitRate = promptTokens > 0 ? (m.usage.cacheRead / promptTokens) * 100 : undefined;
					} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
						const u = entry.message.usage;
						input += u.input;
						output += u.output;
						cacheRead += u.cacheRead;
						cacheWrite += u.cacheWrite;
					} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
						const u = entry.usage;
						input += u.input;
						output += u.output;
						cacheRead += u.cacheRead;
						cacheWrite += u.cacheWrite;
					}
				}

				// ---- Context usage ----
				const contextUsage = ctx.getContextUsage();
				const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				const percentValue = contextUsage?.percent ?? 0;
				const percent = contextUsage?.percent != null ? percentValue.toFixed(1) : "?";

				// ---- pwd line: cwd (~), git branch, session name ----
				let pwd = formatCwdForFooter(
					ctx.sessionManager.getCwd(),
					process.env.HOME || process.env.USERPROFILE,
				);
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				const sessionName = ctx.sessionManager.getSessionName();
				if (sessionName) pwd = `${pwd} • ${sessionName}`;

				// pwd 行右侧：仅"计划模式"状态（key 为 plan-mode）右对齐到第一行，
				// 其余扩展状态仍拼在第三行左侧；窄终端优先截断 cwd 给它让位
				const minPadding = 2;
				const extensionStatuses = footerData.getExtensionStatuses();
				const planStatusRaw = extensionStatuses.get("plan-mode");
				const planStatus = planStatusRaw ? sanitizeStatusText(planStatusRaw) : "";
				const planStatusWidth = visibleWidth(planStatus);

				const pwdAvailable = planStatusWidth > 0 ? Math.max(0, width - planStatusWidth - minPadding) : width;
				const pwdLeft = truncateToWidth(theme.fg("dim", pwd), pwdAvailable, theme.fg("dim", "..."));
				const pwdPadding = " ".repeat(Math.max(0, width - visibleWidth(pwdLeft) - planStatusWidth));
				const pwdLine = pwdLeft + pwdPadding + planStatus;

				// ---- Stats line (Chinese labels; cost part intentionally omitted) ----
				const statsParts: string[] = [];
				// 每个字段单独包 dim：不能整行统一包，否则上下文百分比的
				// error/warning 颜色码 \x1b[0m 复位会冲掉外层 dim
				statsParts.push(theme.fg("dim", `输入:${formatTokens(input)}`));
				statsParts.push(theme.fg("dim", `输出:${formatTokens(output)}`));
				statsParts.push(theme.fg("dim", `缓存命中率:${latestCacheHitRate !== undefined ? `${latestCacheHitRate.toFixed(1)}%` : "-"}`));

				// Context percentage with the same color thresholds as the default footer
				const percentDisplay = percent === "?" ? `?/${formatTokens(contextWindow)}` : `${percent}%/${formatTokens(contextWindow)}`;
				const contextSegment = `上下文使用百分比:${percentDisplay}`;
				let percentStr: string;
				if (percentValue > 90) {
					percentStr = theme.fg("error", contextSegment);
				} else if (percentValue > 70) {
					percentStr = theme.fg("warning", contextSegment);
				} else {
					percentStr = theme.fg("dim", contextSegment);
				}
				// ---- TPS 段（pi-token-speed 合并而来，内嵌在 stats 行） ----
				statsParts.push(buildTpsSegment(theme));

				// 上下文百分比放在 TPS 之后
				statsParts.push(percentStr);

				let statsLeft = statsParts.join(" ");
				if (visibleWidth(statsLeft) > width) {
					statsLeft = truncateToWidth(statsLeft, width, "...");
				}

				// ---- Third line: extension statuses (left) + model name (right-aligned) ----
				// 模型行固定为第三行；扩展状态（ctx.ui.setStatus）拼在左侧，超宽时优先截断状态
				const modelName = ctx.model?.id || "no-model";
				let rightSide = modelName;
				if (ctx.model?.reasoning) {
					const thinkingLevel = ctx.thinkingLevel || "off";
					const levelText = thinkingLevel === "off" ? "thinking off" : thinkingLevel;
					rightSide = `${modelName} • ${theme.getThinkingBorderColor(thinkingLevel)(levelText)}`;
				}

				let rightSideWidth = visibleWidth(rightSide);
				if (rightSideWidth > width) {
					rightSide = truncateToWidth(rightSide, width, "");
					rightSideWidth = visibleWidth(rightSide);
				}

				let statusLine = Array.from(extensionStatuses.entries())
					.filter(([key]) => key !== "plan-mode")
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text))
					.join(" ");
				let statusWidth = visibleWidth(statusLine);

				// 给模型名留出最小间距；状态行放不下时优先截断状态，模型名尽量完整
				const availableForStatus = width - minPadding - rightSideWidth;
				if (statusWidth > 0) {
					if (availableForStatus <= 0) {
						statusLine = "";
						statusWidth = 0;
					} else if (statusWidth > availableForStatus) {
						statusLine = truncateToWidth(statusLine, availableForStatus, theme.fg("dim", "..."));
						statusWidth = visibleWidth(statusLine);
					}
				}

				const padding = " ".repeat(Math.max(0, width - statusWidth - rightSideWidth));
				const modelLine = statusLine + theme.fg("dim", padding + rightSide);

				const lines = [pwdLine, statsLeft, modelLine];

				return lines;
			},
		};
	});
}

/** 注册中文 footer、/tps 命令与全部 TPS 事件接线（由 index.ts 的入口调用一次） */
export function installFooterFeature(pi: ExtensionAPI): void {
	const tpsCommand = new TpsCommand(tpsEngine, () => tuiRef?.requestRender());

	// /tps 设置菜单（显示模式、服务商计数、计数策略、结束后行为）
	pi.registerCommand("tps", {
		description: "打开 TPS 设置菜单，配置显示模式、Token 计数策略与服务商 Token 计数",
		handler: (_args, ctx) => tpsCommand.run(ctx),
	});

	// session_start also fires on resume/fork, so the custom footer stays active
	pi.on("session_start", async (_event, ctx) => {
		// TPS 配置初始化（先于引擎）
		await tpsSettings.initialize();
		const errors = tpsSettings.getErrors();
		if (errors.length > 0 && ctx.hasUI) {
			ctx.ui.notify(["[zh-for-pi:tps]", ...errors].join("\n"), "warning");
		}
		tpsEngine.initialize();

		// footer 与编辑器组件为 TUI 专属（docs: 用 ctx.mode === "tui" 守卫）
		if (ctx.mode !== "tui") return;
		installFooter(ctx);
		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new FixedBorderEditor(tui, editorTheme, keybindings));
	});

	pi.on("session_shutdown", () => {
		tpsEngine.stop();
	});

	// 用户消息发出时开始 TTFT 计时
	pi.on("message_start", (event: { message?: { role?: string } }) => {
		if (event.message?.role === "user") {
			tpsEngine.startTTFT();
		}
	});

	pi.on("message_update", (event) => {
		handleTpsMessageUpdate(event as TpsMessageUpdatePayload);
	});

	pi.on("agent_end", (event: AgentEndEvent) => {
		handleTpsAgentEnd(event);
	});
}
