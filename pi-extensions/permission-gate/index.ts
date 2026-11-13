/**
 * Permission Gate Extension（权限闸门）
 *
 * 运行潜在危险的 bash 命令前弹窗请求确认。
 * 检查模式：rm（任意）、sudo、chmod/chown 777
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { getCommandPage, MAX_COMMAND_VIEWPORT_HEIGHT } from "./dialog-layout.ts";

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
					const showBorder = safeWidth >= 6;
					const contentWidth = Math.max(1, safeWidth - (showBorder ? 4 : 0));
					const terminalRows = Math.max(1, tui.terminal.rows);
					const availableRows = Math.max(1, Math.floor((terminalRows * MAX_DIALOG_HEIGHT_PERCENT) / 100));
					const showHorizontalBorder = availableRows >= 3;
					const horizontalBorderRows = showHorizontalBorder ? 2 : 0;
					const singleRowOptions = availableRows - horizontalBorderRows < 2;
					const minimal = availableRows - horizontalBorderRows < 5;
					const compact = availableRows < 9 + MAX_COMMAND_VIEWPORT_HEIGHT;
					const fixedRows =
						horizontalBorderRows + (singleRowOptions ? 1 : minimal ? 2 : compact ? 4 : 7);
					const maxViewportHeight = Math.max(
						0,
						Math.min(MAX_COMMAND_VIEWPORT_HEIGHT, availableRows - fixedRows),
					);

					let commandLines = commandText.render(contentWidth);
					let hasOverflow = commandLines.length > maxViewportHeight;
					// 仅在内容溢出时保留右侧滚动条列，短命令仍使用完整宽度。
					if (hasOverflow && contentWidth > 1) {
						commandLines = commandText.render(contentWidth - 1);
						hasOverflow = commandLines.length > maxViewportHeight;
					}

					contentHeight = commandLines.length;
					// 视口高度由可用空间决定；getCommandPage 会为短命令补齐空行。
					viewportHeight = maxViewportHeight;
					scrollTop = Math.max(0, Math.min(scrollTop, contentHeight - viewportHeight));
					const visibleLines = getCommandPage(commandLines, scrollTop, viewportHeight);
					const showScrollbar = hasOverflow && viewportHeight > 0 && contentWidth > 1;

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
						return truncateToWidth(line, contentWidth - 1, "", true) + scrollbar;
					});
					const title = theme.fg("warning", theme.bold("⚠ 需要授权 · 命令尚未执行"));
					const question = theme.fg("warning", "是否允许执行？");
					const selectedOption = selectList.getSelectedItem()?.value;
					const options = singleRowOptions
						? [
								["允许", "拒绝"]
									.map((option) => {
										const text = option === selectedOption ? `→ ${option}` : `  ${option}`;
										return option === selectedOption ? theme.fg("accent", text) : text;
									})
									.join("  "),
							]
						: selectList.render(contentWidth);
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
									theme.fg("dim", "↑/↓ 选择 · Enter 确认 · Esc 拒绝 · 滚轮查看命令"),
								];
					const bodyLines = lines.map((line) => {
						const content = truncateToWidth(line, contentWidth, "");
						if (!showBorder) return truncateToWidth(content, safeWidth, "");
						const horizontalPadding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
						return theme.fg("warning", "│ ") + content + horizontalPadding + theme.fg("warning", " │");
					});
					if (!showHorizontalBorder) return bodyLines;
					if (!showBorder) {
						const horizontalBorder = theme.fg("warning", "─".repeat(safeWidth));
						return [horizontalBorder, ...bodyLines, horizontalBorder];
					}
					const horizontalLine = "─".repeat(Math.max(0, safeWidth - 2));
					return [
						theme.fg("warning", `╭${horizontalLine}╮`),
						...bodyLines,
						theme.fg("warning", `╰${horizontalLine}╯`),
					];
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
