/**
 * hidden-commands — 从 / 补全菜单隐藏指定内置命令
 *
 * 隐藏列表来自本扩展目录下的 hidden-commands.json（JSON 数组，字符串元素为命令名，
 * 不带斜杠）。文件不存在时自动创建为 [ "llama" ]；JSON 非法或顶层不是数组时
 * 退化为不隐藏任何命令，并在 session_start 时 warning 提示。
 * 仅影响补全菜单显示：命令本体仍在，手打仍可调起。修改配置后 /reload 生效。
 *
 * 机制：addAutocompleteProvider 链式包装内置 provider，按 item.label 过滤。
 * 只读 label，与其他包装器（如 zh-for-pi 的描述汉化）的加载顺序无关。
 *
 * 对应 pi 版本：0.84.4（AutocompleteProvider，pi-tui）
 */
import { getAgentDir, type AutocompleteProviderFactory, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_PATH = join(getAgentDir(), "extensions", "hidden-commands", "hidden-commands.json");
/** pi 内置 llama.cpp router 模型管理面板；不用 llama.cpp 时纯属菜单噪音 */
const DEFAULT_HIDDEN = ["llama"];

/** 读取隐藏列表。文件缺失时写入默认配置；配置非法时返回空集合 + 错误文案。 */
function loadHidden(): { hidden: ReadonlySet<string>; error?: string } {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf8");
	} catch {
		try {
			writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_HIDDEN, null, 2) + "\n", "utf8");
			return { hidden: new Set(DEFAULT_HIDDEN) };
		} catch (e) {
			return { hidden: new Set(DEFAULT_HIDDEN), error: `无法写入默认配置 ${CONFIG_PATH}：${e}` };
		}
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { hidden: new Set(), error: `hidden-commands.json 不是合法 JSON：${e}` };
	}
	if (!Array.isArray(parsed)) {
		return { hidden: new Set(), error: "hidden-commands.json 顶层必须是数组（元素为命令名字符串）" };
	}
	// 非字符串元素忽略，容忍手写配置的小瑕疵
	return { hidden: new Set(parsed.filter((x): x is string => typeof x === "string")) };
}

// 模块顶层加载配置：startup 与 /reload 时扩展模块重新执行，配置随之刷新。
const { hidden, error } = loadHidden();

/** 过滤 wrapper：委托内置 provider 取建议，按 label 剔除隐藏项，其余一概不动。 */
const wrapProvider: AutocompleteProviderFactory = (current: AutocompleteProvider): AutocompleteProvider => ({
	...(current.triggerCharacters && { triggerCharacters: current.triggerCharacters }),
	async getSuggestions(lines, cursorLine, cursorCol, options) {
		const result = await current.getSuggestions(lines, cursorLine, cursorCol, options);
		if (!result) return result;
		return { ...result, items: result.items.filter((item) => !hidden.has(item.label)) };
	},
	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	},
	shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
		return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	},
});

export default function (pi: ExtensionAPI) {
	// session_start 在 startup/new/resume/fork/reload 均触发；过滤幂等，重复注册无副作用。
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (error) ctx.ui.notify(`hidden-commands：${error}`, "warning");
		ctx.ui.addAutocompleteProvider(wrapProvider);
	});
}
