/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Prompt to exit plan mode after each agent response
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSafeCommand } from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "ask_questions"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);

interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("warning", "计划模式"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools([
			...new Set([
				...toolsBeforePlanMode.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
				...PLAN_MODE_TOOLS,
			]),
		]);
	}

	function restoreNormalModeTools(): void {
		if (toolsBeforePlanMode !== undefined) {
			pi.setActiveTools(toolsBeforePlanMode);
			toolsBeforePlanMode = undefined;
		}
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			toolsBeforePlanMode,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("计划模式已开启：内置写入工具已禁用。");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("计划模式已关闭：已恢复完整权限。");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "切换计划模式（只读探索）",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `计划模式：命令被拦截（不在只读白名单内）。如需执行请先使用 /plan 退出计划模式。\n命令：${command}`,
			};
		}
	});

	// Filter out stale plan mode context when not in plan mode
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan mode context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the ask_questions tool.
Use the available web search MCP tools (e.g. Tavily, exa) for web research.

Explore the codebase and describe your proposed approach.
Do NOT attempt to make changes - just describe what you would do.`,
					display: false,
				},
			};
		}
	});

	// After each response in plan mode, offer to stay or exit
	pi.on("agent_end", async (_event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		const choice = await ctx.ui.select("计划模式 - 下一步？", [
			"留在计划模式（继续只读探索）",
			"退出计划模式（恢复完整权限）",
		]);

		if (choice?.startsWith("退出")) {
			togglePlanMode(ctx);
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
