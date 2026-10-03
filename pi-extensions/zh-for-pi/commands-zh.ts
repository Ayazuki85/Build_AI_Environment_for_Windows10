/**
 * commands-zh — 斜杠命令描述汉化
 *
 * 翻译表（命令名 → 纯中文描述）+ 描述替换纯函数。
 * 表值不含 argumentHint（<...>）与来源标记（[...]），前缀由 localizeDescription 自动保留。
 * 补全项隐藏功能已拆分为独立插件 hidden-commands（见 ~/.pi/agent/extensions/hidden-commands）。
 *
 * 对应 pi 版本：1.0.0（BUILTIN_SLASH_COMMANDS，dist/core/slash-commands.js）
 */
import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

/** 内置斜杠命令中文描述（键 = 命令名；右侧注释为 pi 1.0.0 英文原文） */
export const ZH_COMMAND_DESCRIPTIONS: Record<string, string> = {
	settings: "打开设置菜单", // Open settings menu
	model: "选择模型（打开选择器界面）", // Select model (opens selector UI)
	tree: "浏览会话树（切换分支）", // Navigate session tree (switch branches)
	thinking: "设置思考级别", // Set thinking level
	"scoped-models": "启用/禁用 Ctrl+P 循环切换的模型", // Enable/disable models for Ctrl+P cycling
	export: "导出会话（默认 HTML，或指定路径：.html/.jsonl）", // Export session (HTML default, or specify path: .html/.jsonl)
	import: "从 JSONL 文件导入并恢复会话", // Import and resume a session from a JSONL file
	share: "将会话分享为私密 GitHub Gist", // Share session as a secret GitHub gist
	bug: "向 Pi 开发者报告 bug", // Report a bug to the Pi developers
	copy: "复制最后一条助手消息到剪贴板", // Copy last agent message to clipboard
	name: "设置会话显示名称", // Set session display name
	session: "显示会话信息与统计", // Show session info and stats
	changelog: "显示更新日志条目", // Show changelog entries
	hotkeys: "显示全部键盘快捷键", // Show all keyboard shortcuts
	fork: "从之前的用户消息创建新分叉", // Create a new fork from a previous user message
	clone: "在当前位置复制当前会话", // Duplicate the current session at the current position
	trust: "保存当前项目的信任决定，供未来会话使用", // Save project trust decision for future sessions
	login: "配置提供商认证", // Configure provider authentication
	logout: "移除提供商认证", // Remove provider authentication
	new: "开始新会话", // Start a new session
	compact: "手动压缩会话上下文", // Manually compact the session context
	resume: "恢复其他会话", // Resume a different session
	reload: "重新加载键位绑定、扩展、技能、提示模板、主题和上下文文件", // Reload keybindings, extensions, skills, prompts, themes, and context files
	quit: "退出 pi", // Quit pi（APP_NAME 为动态值，默认 "pi"）
};

/**
 * pi 捆绑扩展命令（dist/extensions/llama、dist/extensions/mcp 经 registerCommand 注册，
 * 不在 BUILTIN_SLASH_COMMANDS 中，不参与「键数 == 内置命令数」的版本核对）
 */
export const ZH_EXTENSION_COMMAND_DESCRIPTIONS: Record<string, string> = {
	llama: "管理 llama.cpp router 模型", // Manage llama.cpp router models
	mcp: "管理 MCP 服务器：登录、重连、启用/禁用与调整暴露范围", // Manage MCP servers: sign in, reconnect, enable or disable, and change exposure
};

/**
 * 替换单条描述为中文，自动保留两类前缀：
 * 1. argumentHint：以 `<` 开头且含 ` — `，保留到第一个 ` — `（含）为止；
 * 2. 来源标记：剩余部分以 `[` 开头且含 `] `，保留到第一个 `] `（含）为止。
 */
export function localizeDescription(description: string | undefined, zh: string): string {
	if (!description) return zh;
	let rest = description;
	let prefix = "";
	if (rest.startsWith("<")) {
		const sep = rest.indexOf(" — ");
		if (sep !== -1) {
			prefix = rest.slice(0, sep + 3);
			rest = rest.slice(sep + 3);
		}
	}
	if (rest.startsWith("[")) {
		const end = rest.indexOf("] ");
		if (end !== -1) {
			prefix += rest.slice(0, end + 2);
			rest = rest.slice(end + 2);
		}
	}
	return prefix + zh;
}

/** 批量替换补全项描述；未命中表的项原样保留（同一对象引用），命中的项浅拷贝后替换，不修改入参 */
export function localizeItems(items: AutocompleteItem[]): AutocompleteItem[] {
	return items.map((item) => {
		const zh = ZH_COMMAND_DESCRIPTIONS[item.label] ?? ZH_EXTENSION_COMMAND_DESCRIPTIONS[item.label];
		if (zh === undefined) return item;
		return { ...item, description: localizeDescription(item.description, zh) };
	});
}

/**
 * autocomplete provider 包装器：委托内置 provider 取建议，把命中翻译表的
 * 命令描述替换为中文。label/value、applyCompletion、触发逻辑全部不动。
 */
export const wrapProvider: AutocompleteProviderFactory = (current: AutocompleteProvider): AutocompleteProvider => ({
	...(current.triggerCharacters && { triggerCharacters: current.triggerCharacters }),
	async getSuggestions(lines, cursorLine, cursorCol, options) {
		const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
		if (!result) return result;
		const items = localizeItems(result.items);
		return { ...result, items };
	},
	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	},
	shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
		return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	},
});
