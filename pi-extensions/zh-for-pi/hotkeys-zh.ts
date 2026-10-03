/**
 * hotkeys-zh — 快捷键帮助汉化（/快捷键 命令）
 *
 * 三区行定义（中文作用）+ 键位格式化 + Markdown 表格构建纯函数。
 * 键位列由调用方注入 getKeys（来自 ctx.ui.custom() 注入的真实 KeybindingsManager，
 * 含用户 keybindings.json 覆盖与平台差异）；本文件不做任何 pi 运行时 import，可独立测试。
 *
 * 对应 pi 版本：1.0.0（handleHotkeysCommand 模板，dist/modes/interactive/interactive-mode.js）
 */

/** 一行定义：ids 为键位 id（tui.editor.* / tui.input.* / app.*），同行多 id 合并显示；
 *  literals 为字面量键（/、!、!!）。ids 与 literals 二选一。 */
export interface HotkeyRow {
	ids?: string[];
	literals?: string[];
	zh: string;
	/** win32 时在 zh 后追加「（Windows Terminal 上为 Ctrl+Enter）」（仅 newLine 行，对齐内置条件文案） */
	win32Note?: boolean;
}

export interface HotkeySection {
	title: string;
	rows: HotkeyRow[];
}

export const SECTIONS: HotkeySection[] = [
	{
		title: "导航",
		rows: [
			{
				ids: [
					"tui.editor.cursorUp",
					"tui.editor.cursorDown",
					"tui.editor.cursorLeft",
					"tui.editor.cursorRight",
				],
				zh: "移动光标 / 浏览历史",
			},
			{ ids: ["tui.editor.cursorWordLeft", "tui.editor.cursorWordRight"], zh: "按词移动" },
			{ ids: ["tui.editor.cursorLineStart"], zh: "移到行首" },
			{ ids: ["tui.editor.cursorLineEnd"], zh: "移到行尾" },
			{ ids: ["tui.editor.jumpForward"], zh: "向前跳到指定字符" },
			{ ids: ["tui.editor.jumpBackward"], zh: "向后跳到指定字符" },
			{ ids: ["tui.editor.pageUp", "tui.editor.pageDown"], zh: "按页滚动" },
		],
	},
	{
		title: "编辑",
		rows: [
			{ ids: ["tui.input.submit"], zh: "发送消息" },
			{ ids: ["tui.input.newLine"], zh: "换行", win32Note: true },
			{ ids: ["tui.editor.deleteWordBackward"], zh: "向前删除一个词" },
			{ ids: ["tui.editor.deleteWordForward"], zh: "向后删除一个词" },
			{ ids: ["tui.editor.deleteToLineStart"], zh: "删到行首" },
			{ ids: ["tui.editor.deleteToLineEnd"], zh: "删到行尾" },
			{ ids: ["tui.editor.yank"], zh: "粘贴最近删除的文本" },
			{ ids: ["tui.editor.yankPop"], zh: "粘贴后循环选择已删文本" },
			{ ids: ["tui.editor.undo"], zh: "撤销" },
		],
	},
	{
		title: "其他",
		rows: [
			{ ids: ["tui.input.tab"], zh: "路径补全 / 接受自动补全" },
			{ ids: ["app.interrupt"], zh: "取消补全 / 中断生成" },
			{ ids: ["app.clear"], zh: "清空输入框（第一次）/ 退出（第二次）" },
			{ ids: ["app.exit"], zh: "退出（输入框为空时）" },
			{ ids: ["app.suspend"], zh: "挂起到后台" },
			{ ids: ["app.thinking.cycle"], zh: "循环切换思考级别" },
			{ ids: ["app.model.cycleForward", "app.model.cycleBackward"], zh: "循环切换模型" },
			{ ids: ["app.model.select"], zh: "打开模型选择器" },
			{ ids: ["app.tools.expand"], zh: "展开/收起工具输出" },
			{ ids: ["app.thinking.toggle"], zh: "显示/隐藏思考块" },
			{ ids: ["app.editor.external"], zh: "在外部编辑器中编辑消息" },
			{ ids: ["app.message.copy"], zh: "复制选中内容或最后一条助手消息" },
			{ ids: ["app.message.followUp"], zh: "排队跟进消息" },
			{ ids: ["app.message.dequeue"], zh: "取回排队消息" },
			{ ids: ["app.clipboard.pasteImage"], zh: "从剪贴板粘贴文件（macOS）、图片或文本" },
			{ literals: ["/"], zh: "斜杠命令" },
			{ literals: ["!"], zh: "运行 bash 命令" },
			{ literals: ["!!"], zh: "运行 bash 命令（不计入上下文）" },
		],
	},
];

/**
 * appendEntry / registerEntryRenderer 共用的 customType。
 * 该字符串会持久化到会话 JSONL；pi 对没有注册 renderer 的 customType 直接跳过不渲染。
 */
export const HOTKEYS_ENTRY_TYPE = "zh-for-pi:hotkeys";

/** appendEntry 的 data 形状（会话 JSONL 持久化，renderer 按此读取） */
export interface HotkeysEntryData {
	markdown: string;
}

const UNBOUND = "（未绑定）";

/** 单个键片段：复刻内置 formatKeyPart 的 capitalize（首字母大写；仅 darwin 上 alt→option） */
export function formatKeyPart(part: string, platform: string = process.platform): string {
	const display = platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return display.charAt(0).toUpperCase() + display.slice(1);
}

/** 单个键：ctrl+b → Ctrl+B */
export function formatKey(key: string, platform?: string): string {
	return key
		.split("+")
		.map((p) => formatKeyPart(p, platform))
		.join("+");
}

/** 同一动作的全部键 `/` 相连：["left","ctrl+b"] → Left/Ctrl+B；空数组 → "" */
export function formatActionKeys(keys: string[], platform?: string): string {
	return keys.map((k) => formatKey(k, platform)).join("/");
}

/** 一行的键位列：多动作用 " / " 相连，未绑定动作的空段被过滤，全部未绑定 → （未绑定）；字面量行原样返回 */
export function formatRowKeys(
	row: HotkeyRow,
	getKeys: (id: string) => string[],
	platform?: string,
): string {
	if (row.literals) return row.literals.join(" / ");
	const parts = (row.ids ?? [])
		.map((id) => formatActionKeys(getKeys(id), platform))
		.filter((s) => s !== "");
	return parts.length > 0 ? parts.join(" / ") : UNBOUND;
}

/**
 * 构建完整 Markdown（不含「键盘快捷键」标题——标题由 entry renderer 以 Text 组件渲染，
 * 与内置 /hotkeys 版式一致）。platform 默认取 process.platform，仅用于 win32Note 行。
 */
export function buildHotkeysMarkdown(
	getKeys: (id: string) => string[],
	platform: string = process.platform,
): string {
	const lines: string[] = [];
	for (const section of SECTIONS) {
		lines.push(`**${section.title}**`, "", "| 按键 | 作用 |", "|------|------|");
		for (const row of section.rows) {
			const keys = formatRowKeys(row, getKeys, platform);
			const note = row.win32Note && platform === "win32" ? "（Windows Terminal 上为 Ctrl+Enter）" : "";
			lines.push(`| \`${keys}\` | ${row.zh}${note} |`);
		}
		lines.push("");
	}
	lines.push("> 扩展注册的快捷键见内置 /hotkeys 的 Extensions 区。");
	return lines.join("\n");
}
