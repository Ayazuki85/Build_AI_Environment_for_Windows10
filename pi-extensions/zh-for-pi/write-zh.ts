/**
 * zh-for-pi — write 工具调用块汉化（截断提示）
 *
 * 复刻内置 write 工具的渲染（dist/core/tools/renderers/write.js 的 renderCall / renderResult，
 * 含流式高亮缓存），把收起态尾注换成中文：
 *   ... (313 more lines, 323 total, ctrl+o to expand)  →  ...（还有 313 行，共 323 行，ctrl+o 展开）
 *   [invalid content arg - expected string]            →  [无效 content 参数 - 应为字符串]
 *
 * 机制与 bash-zh.ts 相同：pi.registerTool 同名覆盖内置 write，execute/参数 schema/
 * promptSnippet/promptGuidelines 全部来自公开工厂 createWriteToolDefinition()，
 * 仅 renderCall/renderResult 换为中文实现；模型看到的工具结果文本不受影响。
 *
 * 已知取舍：
 * - 渲染是内置实现的快照：pi 升级若改了 write 渲染，需同步本文件（见 update-playbook.md）
 * - 展开键位经 ctx.ui.custom() 捕获真实 KeybindingsManager（同 bash-zh.ts），
 *   捕获失败兜底显示 pi 默认键位 ctrl+o
 * - 语法高亮/语言识别用包根导出的 highlightCode/getLanguageFromPath，与内置同源；
 *   render-utils 的 str/replaceTabs/normalizeDisplayText/shortenPath/linkPath 未公开导出，
 *   此处为逐行复刻（含终端超链接支持）
 * - 仅在 TUI 模式注册覆盖（print/rpc 无渲染需求，不动内置工具）
 *
 * 对应 pi 版本：0.87.1
 */

import {
	createWriteToolDefinition,
	getLanguageFromPath,
	highlightCode,
	type AgentToolResult,
	type ExtensionAPI,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, hyperlink, Text, type Component } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatKeyTextLower } from "./header-zh.ts";

// —— 结构化类型（write 的 ToolRenderContext 未从包根导出，此处为兼容子集）——

/** 与内置 writeSchema 同构：{ path: string; content: string } */
interface ZhWriteArgs {
	file_path?: string;
	path?: string;
	content?: string;
}

interface ZhWriteCallContext {
	readonly expanded: boolean;
	readonly isPartial: boolean;
	readonly argsComplete: boolean;
	readonly cwd: string;
	readonly lastComponent: Component | undefined;
}

interface ZhWriteResultContext {
	readonly isError: boolean;
	readonly lastComponent: Component | undefined;
}

// —— 复刻 dist/core/tools/render-utils.js 与 utils/paths.js 的未导出助手 ——

function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

function shortenPath(path: string): string {
	if (typeof path !== "string") return "";
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** resolvePath 的显示用简化版：~ 展开 + 相对 cwd 解析 */
function resolveForLink(rawPath: string, cwd: string): string {
	const expanded = rawPath.replace(/^~(?=$|\/)/, homedir());
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	return hyperlink(styledText, pathToFileURL(resolveForLink(rawPath, cwd)).href);
}

function renderToolPathZh(rawPath: string | null, theme: Theme, cwd: string): string {
	if (rawPath === null) return theme.fg("error", "[无效参数]");
	const value = rawPath;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}

// —— 复刻 dist/core/tools/write.js 的高亮缓存与 formatWriteCall（两处文案汉化）——

interface WriteHighlightCache {
	rawPath: string;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
}

class ZhWriteCallRenderComponent extends Text {
	cache: WriteHighlightCache | undefined;
	constructor() {
		super("", 0, 0);
	}
}

const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

function rebuildWriteHighlightCacheFull(
	rawPath: string,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath)
		return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (!fileContent.startsWith(cache.rawContent))
		return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);

	cache.rawContent = fileContent;
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}
	const segments = deltaNormalized.split("\n");
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(
		cache.normalizedLines[lastIndex] ?? "",
		cache.lang,
	);
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i] ?? "");
		cache.highlightedLines.push(highlightSingleLine(segments[i] ?? "", cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function formatWriteCallZh(
	args: ZhWriteArgs,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
	expandKey: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = renderToolPathZh(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;
	if (fileContent === null) {
		text += `\n\n${theme.fg("error", "[无效 content 参数 - 应为字符串]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			// 原文 `\n... (${remaining} more lines, ${totalLines} total, ${keyHint("app.tools.expand", "to expand")})`
			text +=
				theme.fg("muted", `\n...（还有 ${remaining} 行，共 ${totalLines} 行，`) +
				theme.fg("dim", expandKey) +
				theme.fg("muted", " 展开）");
		}
	}
	return text;
}

/** 复刻内置 formatWriteResult：仅错误时显示输出（保持英文原文，与模型所见一致） */
function formatWriteResultZh(
	result: AgentToolResult<undefined>,
	isError: boolean,
	theme: Theme,
): string | undefined {
	if (!isError) return undefined;
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => ("text" in c ? (c.text ?? "") : ""))
		.join("\n");
	if (!output) return undefined;
	return `\n${theme.fg("error", output)}`;
}

// —— 安装 ——

/**
 * session_start 时以同名工具覆盖内置 write（new/resume/fork/reload 后自动重装；
 * registerTool 在会话中即时生效，无需重启）。
 * 要恢复内置英文渲染：删除 index.ts 中 installWriteZhFeature(pi) 一行并 /reload。
 */
export function installWriteZhFeature(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// 展开键位：经 custom() 捕获真实 KeybindingsManager（含 keybindings.json 覆盖与
		// 平台差异，同 bash-zh.ts）；同步 done 零闪烁。失败兜底 pi 默认 ctrl+o。
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

		// execute/参数/系统提示片段与内置同源；仅替换两个渲染槽位
		const base = createWriteToolDefinition(ctx.sessionManager.getCwd());
		pi.registerTool({
			...base,
			renderCall: (args, theme, context) => {
				const renderArgs = args as ZhWriteArgs;
				const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
				const fileContent = str(renderArgs?.content);
				const component =
					context.lastComponent instanceof ZhWriteCallRenderComponent
						? context.lastComponent
						: new ZhWriteCallRenderComponent();
				if (fileContent !== null) {
					component.cache = context.argsComplete
						? rebuildWriteHighlightCacheFull(rawPath ?? "", fileContent)
						: updateWriteHighlightCacheIncremental(component.cache, rawPath ?? "", fileContent);
				} else {
					component.cache = undefined;
				}
				component.setText(
					formatWriteCallZh(
						renderArgs,
						{ expanded: context.expanded, isPartial: context.isPartial },
						theme,
						component.cache,
						context.cwd,
						expandKey,
					),
				);
				return component;
			},
			renderResult: (result, _options, theme, context) => {
				const output = formatWriteResultZh(result, context.isError, theme);
				if (!output) {
					const component = (context.lastComponent as Container | undefined) ?? new Container();
					component.clear();
					return component;
				}
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(output);
				return text;
			},
		});
	});
}
