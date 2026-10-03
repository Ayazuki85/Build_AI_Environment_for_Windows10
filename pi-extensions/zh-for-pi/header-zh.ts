/**
 * header-zh — 启动页眉汉化（logo 下方的快捷键提示 + onboarding 文案）
 *
 * 复刻内置 builtInHeader（interactive-mode.js init() 中的 ExpandableText）：
 * 收起态 = logo + 单行紧凑提示 + onboarding 两行；展开态（ctrl+o）= logo +
 * 完整快捷键清单 + onboarding。组件实现 setExpanded，pi 的 ctrl+o
 * （app.tools.expand → setToolsExpanded → activeHeader.setExpanded）会同步调用。
 *
 * 机制：session_start 时 ctx.ui.setHeader() 替换内置页眉（含 new/resume/fork/reload
 * 后的重新安装）。键位读真实生效键位——ctx.ui.custom() 注入的 KeybindingsManager
 * （同步 done 捕获、零闪烁，同 /快捷键），改过 keybindings.json 后显示自定义键位。
 * 安静启动（quietStartup: true）时内置页眉为空 Text，本功能跳过安装。
 *
 * 对应 pi 版本：1.0.0（模板见 dist/modes/interactive/interactive-mode.js init()，
 * 键位辅助见 dist/modes/interactive/components/keybinding-hints.js）
 */

import { getAgentDir, VERSION, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Keybinding } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { getByPath, loadSettings } from "./settings-io.ts";

// —— 行定义（数据驱动；顺序与内置 expandedInstructions / compactInstructions 一致）——

/** 键位段：id 解析为当前绑定键（小写格式，与内置 keyText 一致）；raw 为字面量段 */
export interface HintSegment {
	id?: string;
	raw?: string;
}

export interface HintRow {
	/** 段间以 join 连接："/" 表多键并列（ctrl+c/ctrl+d），" " 表「ctrl+c 连按两次」 */
	segments: HintSegment[];
	join: "/" | " ";
	/** 中文作用描述（muted 色，跟在键位后） */
	zh: string;
}

/** 展开态完整清单（pi 1.0.0 英文原文 19 条，见 init() expandedInstructions） */
export const EXPANDED_ROWS: HintRow[] = [
	{ segments: [{ id: "app.interrupt" }], join: "/", zh: "中断生成" }, // to interrupt
	{ segments: [{ id: "app.clear" }], join: "/", zh: "清空输入框" }, // to clear
	// 原文 rawKeyHint(`${keyText("app.clear")} twice`, "to exit")
	{ segments: [{ id: "app.clear" }, { raw: "连按两次" }], join: " ", zh: "退出" },
	{ segments: [{ id: "app.exit" }], join: "/", zh: "退出（输入框为空时）" }, // to exit (empty)
	{ segments: [{ id: "app.suspend" }], join: "/", zh: "挂起到后台" }, // to suspend
	{ segments: [{ id: "tui.editor.deleteToLineEnd" }], join: "/", zh: "删到行尾" }, // to delete to end
	{ segments: [{ id: "app.thinking.cycle" }], join: "/", zh: "循环切换思考级别" }, // to cycle thinking level
	// 原文 `${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}` to cycle models
	{
		segments: [{ id: "app.model.cycleForward" }, { id: "app.model.cycleBackward" }],
		join: "/",
		zh: "循环切换模型",
	},
	{ segments: [{ id: "app.model.select" }], join: "/", zh: "打开模型选择器" }, // to select model
	{ segments: [{ id: "app.tools.expand" }], join: "/", zh: "展开/收起工具输出" }, // to expand tools
	{ segments: [{ id: "app.thinking.toggle" }], join: "/", zh: "显示/隐藏思考块" }, // to expand thinking
	{ segments: [{ id: "app.editor.external" }], join: "/", zh: "在外部编辑器中编辑消息" }, // for external editor
	{ segments: [{ raw: "/" }], join: "/", zh: "斜杠命令" }, // for commands
	{ segments: [{ raw: "!" }], join: "/", zh: "运行 bash 命令" }, // to run bash
	{ segments: [{ raw: "!!" }], join: "/", zh: "运行 bash 命令（不计入上下文）" }, // to run bash (no context)
	{ segments: [{ id: "app.message.followUp" }], join: "/", zh: "排队跟进消息" }, // to queue follow-up
	{ segments: [{ id: "app.message.dequeue" }], join: "/", zh: "取回并编辑排队消息" }, // to edit all queued messages
	{ segments: [{ id: "app.clipboard.pasteImage" }], join: "/", zh: "粘贴文件（macOS）、图片或文本" }, // to paste files on macOS, images, or text
	// 原文 rawKeyHint("drop files", "to attach")
	{ segments: [{ raw: "拖入文件" }], join: "/", zh: "添加为附件" },
];

/** 收起态紧凑提示（pi 1.0.0 英文原文 5 条，见 init() compactInstructions，以 muted " · " 相连） */
export const COMPACT_ROWS: HintRow[] = [
	{ segments: [{ id: "app.interrupt" }], join: "/", zh: "中断" }, // interrupt
	// 原文 `${keyText("app.clear")}/${keyText("app.exit")}` clear/exit
	{ segments: [{ id: "app.clear" }, { id: "app.exit" }], join: "/", zh: "清空/退出" },
	{ segments: [{ raw: "/" }], join: "/", zh: "命令" }, // commands
	{ segments: [{ raw: "!" }], join: "/", zh: "bash" }, // bash
	{ segments: [{ id: "app.tools.expand" }], join: "/", zh: "更多" }, // more
];

/**
 * 收起态第二行：原文 `Press ${keyText("app.tools.expand")} to show full startup help${showDetails ? " and loaded resources" : ""}.`
 * （showDetails = 内置 shouldShowStartupDetails()：quietStartup 为 true/"header" 时隐藏 details）
 */
export const COMPACT_ONBOARDING_ZH = (expandKey: string, showDetails: boolean): string =>
	`按 ${expandKey} 显示完整启动帮助${showDetails ? "与已加载资源" : ""}。`;

/** 原文 "Pi can explain its own features and look up its docs. Ask it how to use or extend Pi." */
export const ONBOARDING_ZH = "Pi 能讲解自己的功能并查阅自己的文档，直接问它怎么用 Pi 或怎么给 Pi 写拓展。";

// —— 构建纯函数（主题结构化入参，可独立测试）——

/** 构建所需的最小主题接口（Theme 天然满足） */
export interface HeaderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface HeaderDeps {
	theme: HeaderTheme;
	/** 真实生效键位查询（来自 ctx.ui.custom() 注入的 KeybindingsManager） */
	getKeys: (id: string) => string[];
	/** logo 主名（内置为未导出的 APP_NAME = pkg.piConfig?.name || "pi"） */
	appName: string;
	version: string;
	/** 内置 shouldShowStartupDetails()：quietStartup 为 true/"header" 时为 false */
	showDetails: boolean;
}

/** 复刻内置 formatKeyText（不 capitalize；仅 darwin 上 alt→option），/ 与 + 分隔符都保留。
 *  与内置唯一差异：escape 显示为 Esc（内置为小写 escape，中文页眉按惯例显示 Esc） */
export function formatKeyTextLower(key: string, platform: string = process.platform): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => {
					if (platform === "darwin" && part.toLowerCase() === "alt") return "option";
					if (part.toLowerCase() === "escape") return "Esc";
					return part;
				})
				.join("+"),
		)
		.join("/");
}

/** 复刻内置 keyText：getKeys(id).join("/") 后格式化；未绑定 → ""（与内置一致，不兜底） */
function keyTextFor(id: string, getKeys: (id: string) => string[]): string {
	return formatKeyTextLower(getKeys(id).join("/"));
}

/** 复刻内置 keyHint/rawKeyHint：dim 键位 + muted 描述 */
function hintText(theme: HeaderTheme, row: HintRow, getKeys: (id: string) => string[]): string {
	const keys = row.segments
		.map((s) => (s.id !== undefined ? keyTextFor(s.id, getKeys) : (s.raw ?? "")))
		.join(row.join);
	return theme.fg("dim", keys) + theme.fg("muted", ` ${row.zh}`);
}

function logoText(deps: HeaderDeps): string {
	return deps.theme.bold(deps.theme.fg("accent", deps.appName)) + deps.theme.fg("dim", ` v${deps.version}`);
}

/** 收起态全文：`${logo}\n${compact}\n${compactOnboarding}\n\n${onboarding}`（与内置一致） */
export function buildCollapsedHeaderText(deps: HeaderDeps): string {
	const compact = COMPACT_ROWS.map((r) => hintText(deps.theme, r, deps.getKeys)).join(
		deps.theme.fg("muted", " · "),
	);
	const compactOnboarding = deps.theme.fg(
		"dim",
		COMPACT_ONBOARDING_ZH(keyTextFor("app.tools.expand", deps.getKeys), deps.showDetails),
	);
	const onboarding = deps.theme.fg("dim", ONBOARDING_ZH);
	return `${logoText(deps)}\n${compact}\n${compactOnboarding}\n\n${onboarding}`;
}

/** 展开态全文：`${logo}\n${expanded}\n\n${onboarding}`（与内置一致） */
export function buildExpandedHeaderText(deps: HeaderDeps): string {
	const expanded = EXPANDED_ROWS.map((r) => hintText(deps.theme, r, deps.getKeys)).join("\n");
	const onboarding = deps.theme.fg("dim", ONBOARDING_ZH);
	return `${logoText(deps)}\n${expanded}\n\n${onboarding}`;
}

// —— 组件与安装 ——

/**
 * 中文启动页眉。paddingX=1/paddingY=0 与内置 ExpandableText 一致；
 * setExpanded 由 pi 的 ctrl+o 切换调用（isExpandable 鸭子类型检测）。
 * 初始恒为收起态：--verbose 的初始展开扩展无法检测（getStartupExpansionState
 * 读 options.verbose），且 setHeader 后 pi 会立即以 toolOutputExpanded(false) 调一次。
 */
export class ZhHeader extends Text {
	constructor(private readonly deps: HeaderDeps) {
		super(buildCollapsedHeaderText(deps), 1, 0);
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? buildExpandedHeaderText(this.deps) : buildCollapsedHeaderText(this.deps));
	}
}

/**
 * session_start 时安装中文启动页眉（new/resume/fork/reload 后自动重装）。
 * 要恢复内置页眉：删除 index.ts 中 installHeaderFeature(pi) 一行并重启 pi
 * （或会话内任意扩展调 ctx.ui.setHeader(undefined)）。
 */
export function installHeaderFeature(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// 安静启动时内置页眉为空 Text，不替换
		const settings = loadSettings(join(getAgentDir(), "settings.json")).settings;
		const quietStartup = getByPath(settings, ["quietStartup"]);
		if (quietStartup === true) return;
		// 内置 shouldShowStartupDetails()：quietStartup === false 才显示 details
		// （--verbose 恒 true 但扩展无法检测，与既有注释一致取设置值）
		const showDetails = quietStartup !== "header";
		// 真实 KeybindingsManager（含 keybindings.json 覆盖与平台差异）：
		// custom() 工厂同步 done 捕获，零闪烁（同 /快捷键 的取键位方式）
		const kb = await ctx.ui.custom<KeybindingsManager>((_tui, _theme, keybindings, done) => {
			done(keybindings);
			return new Container();
		});
		ctx.ui.setHeader(
			(_tui, theme) =>
				new ZhHeader({
					theme,
					getKeys: (id) => kb.getKeys(id as Keybinding),
					appName: "pi", // 内置 APP_NAME 未导出；仅品牌 fork（pkg.piConfig.name）会不同
					version: VERSION,
					showDetails,
				}),
		);
	});
}
