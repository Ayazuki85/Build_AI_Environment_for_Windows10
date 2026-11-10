/**
 * zh-for-pi — write 工具调用块汉化（截断提示 / 无效参数）
 *
 * 直接复用 1.5.1 内置 write 渲染器，不再复刻路径解析或高亮缓存：
 *   ... (313 more lines, 323 total, ctrl+o to expand)  →  ...（还有 313 行，共 323 行，ctrl+o 展开）
 *   [invalid content arg - expected string]            →  [无效 content 参数 - 应为字符串]
 *
 * 机制：createWriteToolDefinition() 提供 execute、schema 和最新 renderCall/renderResult。
 * 内置 renderCall 是同步函数，最终通过 Text.setText() 写入已格式化的文本；这里只在调用期间
 * 临时包装 Text.prototype.setText()，翻译两个固定文案，finally 立即恢复原方法。返回的仍是
 * 内置 WriteCallRenderComponent，因此 lastComponent、CodeHighlighter、主题/语法数量失效、
 * Windows 路径缩写和 OSC 8 链接全部保留上游行为。模型看到的工具结果不受影响。
 *
 * 只翻译由参数和折叠状态确认的提示，避免误改代码正文中的相似文本。若上游文案变化，
 * 精确匹配会失败并安全回退为英文，不影响渲染。
 *
 * 对应 pi 版本：1.5.1
 */

import { createWriteToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface WriteArgsLike {
	content?: unknown;
}

interface CollapsedWriteHint {
	remaining: number;
	total: number;
}

/** 计算内置收起态应当出现的行数提示；展开或不超过 10 行时无提示。 */
function collapsedWriteHint(args: WriteArgsLike, expanded: boolean): CollapsedWriteHint | undefined {
	if (expanded || typeof args.content !== "string" || args.content.length === 0) return undefined;
	const lines = args.content.replace(/\r/g, "").split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	if (end <= 10) return undefined;
	return { remaining: end - 10, total: end };
}

/** 替换内置 renderCall 的固定英文文案；未匹配时保持原文。 */
export function translateWriteCallText(
	text: string,
	hint: CollapsedWriteHint | undefined,
	invalidContent: boolean,
): string {
	let translated = text;
	if (invalidContent) {
		const marker = "[invalid content arg - expected string]";
		// 错误段位于末尾；从最后出现处替换，避免路径中的同名文本抢先匹配。
		const start = translated.lastIndexOf(marker);
		if (start >= 0) {
			translated =
				translated.slice(0, start) + "[无效 content 参数 - 应为字符串]" + translated.slice(start + marker.length);
		}
	}
	if (!hint) return translated;

	// theme.fg() 会在提示前后加入 ANSI，但括号内的数字与英文保持为纯文本。
	const marker = `\n... (${hint.remaining} more lines, ${hint.total} total,`;
	const start = translated.lastIndexOf(marker);
	if (start < 0) return translated;
	const suffix = translated.slice(start);
	if (!suffix.includes("to expand")) return translated;

	let zhSuffix = suffix
		.replace(marker, `\n...（还有 ${hint.remaining} 行，共 ${hint.total} 行，`)
		.replace("to expand", "展开");
	const closing = zhSuffix.lastIndexOf(")");
	if (closing < 0) return translated;
	zhSuffix = `${zhSuffix.slice(0, closing)}）${zhSuffix.slice(closing + 1)}`;
	return translated.slice(0, start) + zhSuffix;
}

/**
 * session_start 时以同名工具覆盖内置 write（new/resume/fork/reload 后自动重装）。
 * 要恢复内置英文渲染：删除 index.ts 中 installWriteZhFeature(pi) 一行并 /reload。
 */
export function installWriteZhFeature(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const base = createWriteToolDefinition(ctx.sessionManager.getCwd());
		const baseRenderCall = base.renderCall;
		if (!baseRenderCall) return;

		pi.registerTool({
			...base,
			renderCall(args, theme, context) {
				const hint = collapsedWriteHint(args, context.expanded);
				const invalidContent = args.content != null && typeof args.content !== "string";
				const originalSetText = Text.prototype.setText;

				// 无 await、无重入窗口；即使内置渲染抛错也必须恢复原型。
				Text.prototype.setText = function (this: Text, text: string): void {
					originalSetText.call(this, translateWriteCallText(text, hint, invalidContent));
				};
				try {
					return baseRenderCall.call(base, args, theme, context);
				} finally {
					Text.prototype.setText = originalSetText;
				}
			},
		});
	});
}
