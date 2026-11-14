/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command to toggle
 * - Shell commands filtered three ways: allow read-only, confirm unknown, block destructive
 * - Prompt to exit plan mode after each agent response
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Analysis, analyzeCommand, analyzePowerShell, clipText } from "./utils.ts";

function buildBlockReason(analysis: Analysis, command: string): string {
	const normalized = command.replace(/\s+/g, " ").trim();
	const segment = analysis.segment?.replace(/\s+/g, " ").trim();
	// Name the segment only when it is part of a compound command; a blocked
	// whole command is already visible in the transcript above.
	const where = segment && segment !== normalized ? `（分段 \`${clipText(segment)}\`）` : "";
	const lines = [`计划模式已拦截${where}：${analysis.reason ?? "属于写操作"}。`];
	if (analysis.suggestion) lines.push(`只读替代：${analysis.suggestion}。`);
	lines.push("如确需执行，请用户输入 /plan 退出计划模式；否则请改用只读方案，不要重试本命令。");
	return lines.join("\n");
}

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

	// Filter shell commands in plan mode: allow read-only, confirm unknown, block destructive
	pi.on("tool_call", async (event, ctx) => {
		if (!planModeEnabled) return;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;

		const command = event.input.command;
		const analysis = event.toolName === "bash" ? analyzeCommand(command) : analyzePowerShell(command);
		if (analysis.decision === "allow") return;

		if (analysis.decision === "ask" && ctx.hasUI) {
			const approved = await ctx.ui.confirm(
				"计划模式：允许执行该命令？",
				`${command}\n\n${analysis.reason ?? "该命令不在只读白名单内。"}`,
			);
			if (approved) return;
			return {
				block: true,
				reason: "用户拒绝了该命令。请不要重试同类命令，改用只读方式继续分析，或请用户输入 /plan 退出计划模式。",
			};
		}

		if (analysis.decision === "ask") {
			return {
				block: true,
				reason: `计划模式：${analysis.reason ?? "命令无法确认只读"}，且当前无法向用户确认。请改用明确的只读命令，或请用户输入 /plan 退出计划模式。`,
			};
		}

		return { block: true, reason: buildBlockReason(analysis, command) };
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
- Bash and PowerShell are filtered: known read-only commands run freely, unknown commands ask the user for confirmation, destructive commands are blocked
If a command is blocked, follow the read-only alternative in the error instead of retrying similar commands.

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
