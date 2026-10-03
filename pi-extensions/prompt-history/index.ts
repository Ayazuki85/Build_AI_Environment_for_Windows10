import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPatch } from "./patch.ts";
import { HistoryStore, resolveHistoryPath } from "./store.ts";

export default function (_pi: ExtensionAPI): void {
	try {
		const store = new HistoryStore(resolveHistoryPath());
		// CustomEditor 的原型链上一级即 pi 内部 Editor 类（同一 bundle 导出，身份一致）
		const editorProto = Object.getPrototypeOf(CustomEditor.prototype) as Record<string | symbol, unknown>;
		installPatch(editorProto, {
			append: (text) => store.append(text),
			recent: (limit) => store.recent(limit),
		});
	} catch {
		// 任何初始化失败都静默降级，绝不影响输入框
	}
}
