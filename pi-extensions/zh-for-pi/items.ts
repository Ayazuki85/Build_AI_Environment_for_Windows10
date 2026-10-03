/**
 * items.ts — 34 个设置项定义表（与内置 /settings 面板一一对应）
 *
 * 数据驱动：pi 更新增删设置项时只需改动本表。
 * 纯数据 + 纯函数，不 import 任何 pi 包，可用 node --test 直接测试。
 *
 * 对应 pi 版本：1.0.0
 * 条目顺序 = 内置面板顺序（bundle 提取）：图片/编辑器/终端类紧跟 autocompact。
 * 条件显示：仅 show-images、image-width-cells 依赖终端图片支持（内置行为，
 * spec 表格误标 4 项）；auto-resize-images、block-images 无条件显示。
 */
import { getByPath, type SettingsObject } from "./settings-io.ts";

/** 写入 settings.json 的原值类型 */
export type RawValue = string | number | boolean;

export interface OptionMap {
	/** SettingsList 中显示的值文本，如 "全屏 (fullscreen)"；专名直接显示原值如 "sse" */
	display: string;
	/** 写入 settings.json 的英文原值 */
	raw: RawValue;
}

export interface ItemDef {
	/** 与内置面板一致的英文 id */
	id: string;
	/** 中文标签 */
	label: string;
	/** 中文描述（选中时显示在列表下方） */
	description: string;
	type: "toggle" | "select" | "submenu";
	/** settings.json 字段路径（段数组；段内可含 "/"，用于 modelThinkingLevels 的 provider/modelId 键） */
	path: string[];
	/** toggle/select 的选项，顺序与内置面板 values 一致；submenu 为空数组 */
	options: OptionMap[];
	/** settings.json 缺省时的 pi 默认值 */
	defaultRaw: RawValue;
	/** 仅终端支持图片时显示 */
	requiresImages?: boolean;
	/** 当前值不在 options 中时的兜底格式化（如自定义 httpIdleTimeoutMs） */
	formatFallback?: (raw: RawValue) => string;
}

const TOGGLE_OPTIONS: OptionMap[] = [
	{ display: "开 (true)", raw: true },
	{ display: "关 (false)", raw: false },
];

function tog(
	id: string,
	label: string,
	description: string,
	path: string[],
	defaultRaw: boolean,
	requiresImages?: boolean,
): ItemDef {
	return { id, label, description, type: "toggle", path, defaultRaw, requiresImages, options: TOGGLE_OPTIONS };
}

function sel(
	id: string,
	label: string,
	description: string,
	path: string[],
	defaultRaw: RawValue,
	options: [string, RawValue][],
	requiresImages?: boolean,
): ItemDef {
	return {
		id,
		label,
		description,
		type: "select",
		path,
		defaultRaw,
		requiresImages,
		options: options.map(([display, raw]) => ({ display, raw })),
	};
}

function sub(id: string, label: string, description: string, path: string[]): ItemDef {
	return { id, label, description, type: "submenu", path, options: [], defaultRaw: "" };
}

// —— HTTP 空闲超时（与内置 HTTP_IDLE_TIMEOUT_CHOICES 一致）——
export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const HTTP_IDLE_ZH: Record<string, string> = {
	"30 sec": "30 秒",
	"1 min": "1 分钟",
	"2 min": "2 分钟",
	"5 min": "5 分钟",
	disabled: "禁用",
};

/** 预设档位显示「中文 (英文标签)」；非预设值显示「N 秒 (N sec)」（与内置格式对齐） */
export function formatHttpIdleTimeout(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((c) => c.timeoutMs === timeoutMs);
	if (choice) return `${HTTP_IDLE_ZH[choice.label]} (${choice.label})`;
	return `${timeoutMs / 1000} 秒 (${timeoutMs / 1000} sec)`;
}

export const ITEMS: ItemDef[] = [
	// —— 紧跟 autocompact 的图片/编辑器/终端组（内置顺序）——
	tog("autocompact", "自动压缩", "上下文过大时自动压缩", ["compaction", "enabled"], true),
	tog("show-images", "显示图片", "在终端内联渲染图片", ["terminal", "showImages"], true, true),
	sel("image-width-cells", "图片宽度", "内联图片首选宽度（字符格数）", ["terminal", "imageWidthCells"], 60, [
		["60", 60],
		["80", 80],
		["120", 120],
	], true),
	tog("auto-resize-images", "自动缩放图片", "大图缩至 2000x2000 以内以提升模型兼容性", ["images", "autoResize"], true),
	tog("block-images", "屏蔽图片", "禁止将图片发送给 LLM 提供商", ["images", "blockImages"], false),
	tog("skill-commands", "技能命令", "将技能注册为 /skill:name 命令", ["enableSkillCommands"], true),
	tog("show-hardware-cursor", "显示硬件光标", "显示终端光标（同时保持 IME 定位）", ["showHardwareCursor"], false),
	sel("editor-padding", "编辑器内边距", "输入编辑器的水平内边距（0-3）", ["editorPaddingX"], 0, [
		["0", 0],
		["1", 1],
		["2", 2],
		["3", 3],
	]),
	sel("output-padding", "输出内边距", "用户消息、助手消息和思考块的水平内边距", ["outputPad"], 1, [
		["0", 0],
		["1", 1],
	]),
	sel("autocomplete-max-visible", "补全列表长度", "自动补全下拉最多可见条数（3-20）", ["autocompleteMaxVisible"], 5, [
		["3", 3],
		["5", 5],
		["7", 7],
		["10", 10],
		["15", 15],
		["20", 20],
	]),
	tog("clear-on-shrink", "收缩时清空", "内容缩短时清空多余行（可能闪烁）", ["terminal", "clearOnShrink"], false),
	tog("terminal-progress", "终端进度", "在终端标签栏显示 OSC 9;4 进度指示", ["terminal", "showTerminalProgress"], false),
	// —— 后半组（内置顺序）——
	sel("steering-mode", "Steering 消息投递", "流式输出期间按 Enter 排入 steering 队列；逐条=发一条等回复，全部=一次全发", ["steeringMode"], "one-at-a-time", [
		["逐条 (one-at-a-time)", "one-at-a-time"],
		["全部 (all)", "all"],
	]),
	sel("follow-up-mode", "Follow-up 消息投递", "快捷键排队 follow-up 消息直至 agent 停止；逐条=发一条等回复，全部=一次全发", ["followUpMode"], "one-at-a-time", [
		["逐条 (one-at-a-time)", "one-at-a-time"],
		["全部 (all)", "all"],
	]),
	sel("transport", "传输协议", "支持多传输方式的提供商的首选协议", ["transport"], "auto", [
		["sse", "sse"],
		["websocket", "websocket"],
		["websocket-cached", "websocket-cached"],
		["自动 (auto)", "auto"],
	]),
	{
		id: "http-idle-timeout",
		label: "HTTP 空闲超时",
		description: "等待 HTTP 头或正文块的最大空闲间隔；本地模型停顿较久可禁用",
		type: "select",
		path: ["httpIdleTimeoutMs"],
		defaultRaw: 300_000,
		options: HTTP_IDLE_TIMEOUT_CHOICES.map((c) => ({ display: formatHttpIdleTimeout(c.timeoutMs), raw: c.timeoutMs })),
		formatFallback: (raw) => formatHttpIdleTimeout(Number(raw)),
	},
	sel("cache-warming-mode", "缓存预热", "off=关闭；streaming=agent 运行期间预热；idle=运行间隙仍有收益时也预热", ["cacheWarming"], "streaming", [
		["关 (off)", "off"],
		["流式 (streaming)", "streaming"],
		["空闲 (idle)", "idle"],
	]),
	tog("hide-thinking", "隐藏思考块", "在助手回复中隐藏思考块", ["hideThinkingBlock"], false),
	sel("mermaid-rendering", "Mermaid 图表", "将 Mermaid 代码块渲染为 Unicode 图", ["markdown", "mermaid"], "streaming", [
		["关 (off)", "off"],
		["完成后渲染 (final)", "final"],
		["流式渲染 (streaming)", "streaming"],
	]),
	tog("cache-miss-notices", "缓存未命中提示", "在会话记录中显示缓存费用与提供商恢复诊断提示", ["showCacheMissNotices"], false),
	tog("collapse-changelog", "精简更新日志", "更新后显示精简版 changelog", ["collapseChangelog"], false),
	sel("quiet-startup", "安静启动", "启动时禁用详细输出（header=仅保留启动页眉）", ["quietStartup"], false, [
		["开 (true)", true],
		["仅页眉 (header)", "header"],
		["关 (false)", false],
	]),
	tog("install-telemetry", "安装遥测", "更新后发送匿名版本上报", ["enableInstallTelemetry"], true),
	sel("default-project-trust", "默认项目信任", "无扩展或无已保存决定时项目信任的兜底行为", ["defaultProjectTrust"], "ask", [
		["询问 (ask)", "ask"],
		["总是信任 (always)", "always"],
		["从不信任 (never)", "never"],
	]),
	sel("double-escape-action", "双击 Esc 动作", "编辑器为空时连按两次 Esc 的动作", ["doubleEscapeAction"], "tree", [
		["会话树 (tree)", "tree"],
		["分叉 (fork)", "fork"],
		["无 (none)", "none"],
	]),
	sel("tree-filter-mode", "会话树默认过滤", "打开 /tree 时的默认过滤器", ["treeFilterMode"], "default", [
		["默认 (default)", "default"],
		["隐藏工具 (no-tools)", "no-tools"],
		["仅用户消息 (user-only)", "user-only"],
		["仅标记 (labeled-only)", "labeled-only"],
		["全部 (all)", "all"],
	]),
	sub("warnings", "警告开关", "启用或禁用各类警告", ["warnings"]),
	sub("model-thinking", "每模型默认思考级别", "为特定模型覆盖默认思考级别", ["modelThinkingLevels"]),
	sel("tui-mode", "界面模式", "界面布局；常规模式使用终端原生滚动缓冲区", ["tuiMode"], "fullscreen", [
		["常规 (regular)", "regular"],
		["全屏 (fullscreen)", "fullscreen"],
	]),
	sel("fullscreen-exit-output", "全屏退出输出", "退出全屏模式时打印完整记录或仅打印会话恢复提示", ["fullscreenExitOutput"], "transcript", [
		["完整记录 (transcript)", "transcript"],
		["仅恢复提示 (resume-hint)", "resume-hint"],
	]),
	sel("fullscreen-scrollbar", "全屏滚动条", "全屏模式滚动条行为；常规模式无效", ["fullscreenScrollbar"], "auto", [
		["自动 (auto)", "auto"],
		["常显 (always)", "always"],
		["隐藏 (hidden)", "hidden"],
	]),
	tog("fullscreen-copy-on-select", "全屏选中复制", "全屏模式下自动复制选中文本；关闭后按 Ctrl+X 复制选中", ["fullscreenCopyOnSelect"], true),
	{
		id: "fullscreen-wheel-scroll-lines",
		label: "全屏滚轮滚动",
		description: "全屏模式每次滚轮事件的滚动行数；auto 在终端不加速时自动加快快速滚动",
		type: "select",
		path: ["fullscreenWheelScrollLines"],
		defaultRaw: "auto",
		options: [
			{ display: "自动 (auto)", raw: "auto" },
			{ display: "1", raw: 1 },
			{ display: "2", raw: 2 },
			{ display: "3", raw: 3 },
			{ display: "5", raw: 5 },
			{ display: "10", raw: 10 },
		],
		formatFallback: (raw) => String(raw),
	},
	sub("theme", "主题", "界面配色主题", ["theme"]),
];

/** 按终端图片支持过滤（仅 show-images、image-width-cells 有条件） */
export function visibleItems(imagesSupported: boolean): ItemDef[] {
	return ITEMS.filter((item) => !item.requiresImages || imagesSupported);
}

/** 当前生效的英文原值：settings.json 已设置用文件值，否则用 pi 默认值 */
export function currentRaw(item: ItemDef, settings: SettingsObject): RawValue {
	const value = getByPath(settings, item.path);
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	return item.defaultRaw;
}

/** 原值 → 显示文本；未命中选项时走 formatFallback，再兜底 String(raw) */
export function displayForRaw(item: ItemDef, raw: RawValue): string {
	const option = item.options.find((o) => o.raw === raw);
	if (option) return option.display;
	if (item.formatFallback) return item.formatFallback(raw);
	return String(raw);
}

/** 显示文本 → 原值；仅对 options 内的 display 可逆（values 循环只会产生这些值） */
export function rawForDisplay(item: ItemDef, display: string): RawValue | undefined {
	return item.options.find((o) => o.display === display)?.raw;
}

/** model-thinking 项的值摘要（内置为 "none" / "N configured"） */
export function modelThinkingSummary(overrides: Record<string, string>): string {
	const count = Object.keys(overrides).length;
	return count === 0 ? "无" : `已配置 ${count} 项`;
}
