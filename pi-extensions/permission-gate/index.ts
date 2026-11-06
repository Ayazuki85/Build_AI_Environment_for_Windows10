/**
 * Permission Gate Extension（权限闸门）
 *
 * 运行潜在危险的 bash 命令前弹窗请求确认。
 * 检查模式：rm（任意）、sudo、chmod/chown 777
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

const MAX_COMMAND_VIEWPORT_HEIGHT = 12;
const MAX_DIALOG_HEIGHT_PERCENT = 80;

async function confirmDangerousCommand(ctx: ExtensionContext, command: string): Promise<string | undefined> {
	// RPC 客户端自行处理对话框布局；只有终端 UI 需要这里的滚动视口。
	if (ctx.mode !== "tui") {
		return ctx.ui.select(`⚠️ 危险命令：\n\n  ${command}\n\n是否允许执行？`, ["允许", "拒绝"]);
	}

	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keybindings, done) => {
			const commandText = new Text(theme.fg("toolOutput", command), 2, 0);
			const selectList = new SelectList(
				[
					{ value: "允许", label: "允许" },
					{ value: "拒绝", label: "拒绝" },
				],
				2,
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			);

			let scrollTop = 0;
			let viewportHeight = 1;
			let contentHeight = 1;

			const scrollBy = (delta: number): boolean => {
				const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
				const next = Math.max(0, Math.min(maxScrollTop, Math.trunc(scrollTop + delta)));
				if (next === scrollTop) return false;
				scrollTop = next;
				return true;
			};

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(undefined);

			return {
				render(width: number): string[] {
					const safeWidth = Math.max(1, Math.floor(width));
					const terminalRows = Math.max(1, tui.terminal.rows);
					const availableRows = Math.max(1, Math.floor((terminalRows * MAX_DIALOG_HEIGHT_PERCENT) / 100));
					const minimal = availableRows < 5;
					const compact = availableRows < 12;
					const fixedRows = minimal ? 2 : compact ? 4 : 7;
					const maxViewportHeight = Math.max(
						0,
						Math.min(MAX_COMMAND_VIEWPORT_HEIGHT, availableRows - fixedRows),
					);

					let commandLines = commandText.render(safeWidth);
					let hasOverflow = commandLines.length > maxViewportHeight;
					// 仅在内容溢出时保留右侧滚动条列，短命令仍使用完整宽度。
					if (hasOverflow && safeWidth > 1) {
						commandLines = commandText.render(safeWidth - 1);
						hasOverflow = commandLines.length > maxViewportHeight;
					}

					contentHeight = commandLines.length;
					viewportHeight = Math.max(0, Math.min(maxViewportHeight, contentHeight));
					scrollTop = Math.max(0, Math.min(scrollTop, contentHeight - viewportHeight));
					const visibleLines = commandLines.slice(scrollTop, scrollTop + viewportHeight);
					const showScrollbar = hasOverflow && viewportHeight > 0 && safeWidth > 1;

					const maxScrollTop = Math.max(1, contentHeight - viewportHeight);
					const thumbHeight = showScrollbar
						? Math.max(
								Math.min(2, viewportHeight),
								Math.min(viewportHeight, Math.round((viewportHeight * viewportHeight) / contentHeight)),
							)
						: 0;
					const thumbOffset = showScrollbar
						? Math.round((scrollTop / maxScrollTop) * (viewportHeight - thumbHeight))
						: 0;

					const renderedCommand = visibleLines.map((line, index) => {
						if (!showScrollbar) return line;
						const isThumb = index >= thumbOffset && index < thumbOffset + thumbHeight;
						const scrollbar = theme.fg(isThumb ? "accent" : "dim", isThumb ? "█" : "│");
						return truncateToWidth(line, safeWidth - 1, "", true) + scrollbar;
					});
					const title = theme.fg("warning", theme.bold("⚠️ 危险命令："));
					const question = theme.fg("warning", "是否允许执行？");
					const options = selectList.render(safeWidth);
					const lines = minimal
						? [...renderedCommand, ...options]
						: compact
							? [title, ...renderedCommand, question, ...options]
							: [
									title,
									"",
									...renderedCommand,
									"",
									question,
									...options,
									theme.fg("dim", "↑/↓ 选择 · Enter 确认 · Esc 拒绝"),
								];
					return lines.map((line) => truncateToWidth(line, safeWidth, ""));
				},
				handleInput(data: string): void {
					selectList.handleInput(data);
					tui.requestRender();
				},
				handleMouse(event: TuiMouseEvent) {
					if (event.type !== "wheel" || !event.wheelDelta) return undefined;
					const changed = scrollBy(event.wheelDelta);
					if (changed) tui.requestRender();
					return { handled: true, render: changed };
				},
				invalidate(): void {
					commandText.invalidate();
					selectList.invalidate();
				},
			};
		},
		{
			// 内联组件会被编辑器外层容器裁剪；模态层可避开 footer/status/widgets 的高度挤压。
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: `${MAX_DIALOG_HEIGHT_PERCENT}%`,
				anchor: "center",
				margin: 0,
			},
		},
	);
}

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

			const choice = await confirmDangerousCommand(ctx, command);

			if (choice !== "允许") {
				return { block: true, reason: "已被用户拒绝" };
			}
		}

		return undefined;
	});
}
