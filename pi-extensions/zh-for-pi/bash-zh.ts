/**
 * zh-for-pi — bash 工具结果块汉化（耗时行 / 截断警告 / 展开提示 / 超时后缀）
 *
 * 复刻内置 bash 工具的渲染（dist/core/tools/renderers/bash.js 的 renderCall / renderResult /
 * rebuildBashResultRenderComponent），把其中英文换成中文：
 *   Elapsed/Took 71.0s                          → 已耗时/耗时 71.0秒
 *   $ cmd (timeout 60s)                         → $ cmd (超时 60秒)
 *   ... (N earlier lines, ctrl+o to expand)     → ...（上方还有 N 行，ctrl+o 展开）
 *   [Full output: X. Truncated: ...]            → [完整输出: X；已截断: ...]
 *
 * 机制：pi.registerTool 同名覆盖内置 bash（docs/extensions.md「Overriding Built-in Tools」，
 * TUI 渲染按槽位解析 toolDefinition.renderResult ?? builtIn.renderResult，见
 * dist/modes/interactive/components/tool-execution.js）。execute/参数 schema/
 * promptSnippet/promptGuidelines 全部来自公开工厂 createBashToolDefinition()，
 * 与内置同源同行为；仅 renderCall/renderResult 换为中文实现。
 * 模型看到的工具结果文本不受影响（纯 TUI 显示层汉化），包括结果尾注
 * "[Showing lines X-Y of Z. Full output: ...]" 仍保持英文发给模型。
 *
 * 已知取舍：
 * - 渲染是内置实现的快照：pi 升级若改了 bash 渲染，需同步本文件（见 update-playbook.md）
 * - 展开键位经 ctx.ui.custom() 捕获真实 KeybindingsManager（同 header-zh.ts），
 *   捕获失败兜底显示 pi 默认键位 ctrl+o
 * - execute 由 jiti 加载的第二份 dist 模块实例提供（双模块），其 trackDetachedChildPid
 *   计入该实例；pi 退出按自身实例清理游离进程，极端情况下此实例启动的 detached
 *   子进程可能不被 pi 统一清理
 * - shellPath/shellCommandPrefix 只读全局 settings.json（不读项目级设置：项目信任
 *   检查前不应影响 shell 选择，也避免不可信仓库注入 shellPath）
 * - 仅在 TUI 模式注册覆盖（print/rpc 无渲染需求，不动内置工具）
 *
 * 对应 pi 版本：1.0.0
 */

import {
	createBashToolDefinition,
	DEFAULT_MAX_BYTES,
	formatSize,
	getAgentDir,
	type AgentToolResult,
	type BashToolDetails,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatKeyTextLower } from "./header-zh.ts";
import { getByPath, loadSettings } from "./settings-io.ts";

/** 收起态预览保留的尾部可视行数（与内置 BASH_PREVIEW_LINES 一致） */
const BASH_PREVIEW_LINES = 5;

// —— 结构化类型（bashSchema / ToolRenderContext 未从包根导出，此处为兼容子集）——

/** 与内置 bashSchema 同构：{ command: string; timeout?: number } */
interface ZhBashArgs {
	command?: string;
	timeout?: number;
}

/** 与内置 BashRenderState 同构（经 context.state 在 renderCall/renderResult 间共享） */
interface ZhBashRenderState {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
}

/** ToolRenderContext 的最小结构化子集（全量类型可赋值进来） */
interface ZhRenderContext {
	readonly executionStarted: boolean;
	readonly isError: boolean;
	readonly showImages: boolean;
	readonly lastComponent: Component | undefined;
	readonly state: ZhBashRenderState;
	invalidate(): void;
}

type ZhBashResult = AgentToolResult<BashToolDetails | undefined>;

// —— 内置 render-utils 的本地化复刻（stripAnsi / sanitizeBinaryOutput 未公开导出）——

// 派生自 ansi-regex（MIT，Sindre Sorhus）——与 dist/utils/ansi.js 同一实现
function ansiRegex(): RegExp {
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;
	const csi =
		"[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
	return new RegExp(`${osc}|${csi}`, "g");
}
const ANSI_PATTERN = ansiRegex();

function stripAnsi(value: string): string {
	if (!value.includes("\u001B") && !value.includes("\u009B")) return value;
	return value.replace(ANSI_PATTERN, "");
}

/** 与 dist/utils/shell.js sanitizeBinaryOutput 一致：滤掉会让 string-width 崩溃的字符 */
function sanitizeBinaryOutput(value: string): string {
	return Array.from(value)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

/** bash 结果只有文本块；内置 getTextOutput 的图片分支对 bash 恒为空，故省略 */
function getBashTextOutput(result: ZhBashResult): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => sanitizeBinaryOutput(stripAnsi(c.text ?? "")).replace(/\r/g, ""))
		.join("\n");
}

/** 复刻内置 truncateToVisualLines：借 Text.render 按宽度折行后取尾部 N 行 */
function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
): { visualLines: string[]; skippedCount: number } {
	if (!text) return { visualLines: [], skippedCount: 0 };
	const all = new Text(text, 0, 0).render(width);
	if (all.length <= maxVisualLines) return { visualLines: all, skippedCount: 0 };
	return { visualLines: all.slice(-maxVisualLines), skippedCount: all.length - maxVisualLines };
}

/** 内置 formatDuration 的中文版：71.0s → 71.0秒；5m 3s → 5分 3秒；1h 2m 3s → 1时 2分 3秒 */
function formatDurationZh(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}秒`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}分 ${remainder}秒`;
	return `${Math.floor(minutes / 60)}时 ${minutes % 60}分 ${remainder}秒`;
}

// —— 结果组件（与内置 BashResultRenderComponent 同构，含预览渲染缓存）——

interface PreviewCache {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
}

class ZhBashResultComponent extends Container {
	cache: PreviewCache = { cachedWidth: undefined, cachedLines: undefined, cachedSkipped: undefined };
}

/** 复刻内置 rebuildBashResultRenderComponent，四处文案汉化 */
function rebuildResultComponent(
	component: ZhBashResultComponent,
	result: ZhBashResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	expandKey: string,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const cache = component.cache;
	component.clear();

	let output = getBashTextOutput(result).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	// 与内置一致：最终态剥掉尾随的面向模型的截断脚注 "[Showing lines X-Y ... Full output: ...]"
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (cache.cachedLines === undefined || cache.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						cache.cachedLines = preview.visualLines;
						cache.cachedSkipped = preview.skippedCount;
						cache.cachedWidth = width;
					}
					if (cache.cachedSkipped && cache.cachedSkipped > 0) {
						// 原文 `... (${skipped} earlier lines, ${keyHint("app.tools.expand", "to expand")})`
						const hint =
							theme.fg("muted", `...（上方还有 ${cache.cachedSkipped} 行，`) +
							theme.fg("dim", expandKey) +
							theme.fg("muted", " 展开）");
						return ["", truncateToWidth(hint, width, "..."), ...(cache.cachedLines ?? [])];
					}
					return ["", ...(cache.cachedLines ?? [])];
				},
				invalidate: () => {
					cache.cachedWidth = undefined;
					cache.cachedLines = undefined;
					cache.cachedSkipped = undefined;
				},
			});
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`完整输出: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`已截断: 共 ${truncation.totalLines} 行，显示 ${truncation.outputLines} 行`);
			} else {
				warnings.push(
					`已截断: 显示 ${truncation.outputLines} 行（${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} 上限）`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join("；")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		// 原文 options.isPartial ? "Elapsed" : "Took"
		const label = options.isPartial ? "已耗时" : "耗时";
		const endTime = endedAt ?? Date.now();
		component.addChild(
			new Text(`\n${theme.fg("muted", `${label} ${formatDurationZh(endTime - startedAt)}`)}`, 0, 0),
		);
	}
}

// —— 两个渲染槽位（签名与内置一致，含共享 state 的计时管理）——

function renderCallZh(args: ZhBashArgs, theme: Theme, context: ZhRenderContext): Component {
	const state = context.state;
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
	// 复刻 formatShellCall(args, "$")：内置经 render-utils 的 str() 归一化——
	// string 原样；null/undefined → ""（显示 "..."）；其他类型 → null（显示错误占位）
	const rawCommand: unknown = args?.command;
	const command: string | null =
		typeof rawCommand === "string" ? rawCommand : rawCommand == null ? "" : null;
	const timeout = args?.timeout;
	// 原文 ` (timeout ${timeout}s)`
	const timeoutSuffix = timeout ? theme.fg("muted", ` (超时 ${timeout}秒)`) : "";
	const commandDisplay =
		command === null ? theme.fg("error", "[无效参数]") : command ? command : theme.fg("toolOutput", "...");
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix);
	return text;
}

function renderResultZh(
	result: ZhBashResult,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ZhRenderContext,
	expandKey: string,
): Component {
	const state = context.state;
	// 进行中的部分结果：每秒 invalidate 一次，驱动「已耗时」走动（与内置一致）
	if (state.startedAt !== undefined && options.isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 1000);
	}
	if (!options.isPartial || context.isError) {
		state.endedAt ??= Date.now();
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	const component =
		context.lastComponent instanceof ZhBashResultComponent
			? context.lastComponent
			: new ZhBashResultComponent();
	rebuildResultComponent(component, result, options, theme, expandKey, state.startedAt, state.endedAt);
	component.invalidate();
	return component;
}

// —— 安装 ——

/**
 * session_start 时以同名工具覆盖内置 bash（new/resume/fork/reload 后自动重装；
 * registerTool 在会话中即时生效，无需重启）。
 * 要恢复内置英文渲染：删除 index.ts 中 installBashZhFeature(pi) 一行并 /reload。
 */
export function installBashZhFeature(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// 展开键位：经 custom() 捕获真实 KeybindingsManager（含 keybindings.json 覆盖与
		// 平台差异，同 header-zh.ts）；同步 done 零闪烁。失败兜底 pi 默认 ctrl+o。
		let expandKey = "ctrl+o";
		try {
			const kb = await ctx.ui.custom<KeybindingsManager>((_tui, _theme, keybindings, done) => {
				done(keybindings);
				return new Container();
			});
			const keys = kb.getKeys("app.tools.expand" as Parameters<KeybindingsManager["getKeys"]>[0]);
			if (keys.length > 0) expandKey = formatKeyTextLower(keys.join("/"));
		} catch {
			/* 保持兜底键位 */
		}

		// 与内置 _buildRuntime 相同的 bash 选项来源（仅全局 settings.json，见文件头注释）
		const settings = loadSettings(join(getAgentDir(), "settings.json")).settings;
		const options: { shellPath?: string; commandPrefix?: string } = {};
		const shellPath = getByPath(settings, ["shellPath"]);
		if (typeof shellPath === "string" && shellPath.length > 0) {
			// 对齐内置 SettingsManager.getShellPath() 的 normalizePath ~ 展开
			options.shellPath = shellPath.replace(/^~(?=$|\/)/, homedir());
		}
		const commandPrefix = getByPath(settings, ["shellCommandPrefix"]);
		if (typeof commandPrefix === "string" && commandPrefix.length > 0) {
			options.commandPrefix = commandPrefix;
		}

		// execute/参数/系统提示片段与内置同源；仅替换两个渲染槽位
		const base = createBashToolDefinition(ctx.sessionManager.getCwd(), options);
		pi.registerTool({
			...base,
			renderCall: (args, theme, context) => renderCallZh(args, theme, context),
			renderResult: (result, resultOptions, theme, context) =>
				renderResultZh(result, resultOptions, theme, context, expandKey),
		});
	});
}
