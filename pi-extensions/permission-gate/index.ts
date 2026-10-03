/**
 * Permission Gate Extension（权限闸门）
 *
 * 运行潜在危险的 bash 命令前弹窗请求确认。
 * 检查模式：rm（任意）、sudo、chmod/chown 777
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dangerousPatterns = [/\brm\b/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = dangerousPatterns.some((p) => p.test(command));

		if (isDangerous) {
			if (!ctx.hasUI) {
				// 非交互模式下默认拦截
				return { block: true, reason: "危险命令已拦截（无 UI 无法确认）" };
			}

			const choice = await ctx.ui.select(`⚠️ 危险命令：\n\n  ${command}\n\n是否允许执行？`, ["允许", "拒绝"]);

			if (choice !== "允许") {
				return { block: true, reason: "已被用户拒绝" };
			}
		}

		return undefined;
	});
}
