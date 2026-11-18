/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

/**
 * CUSTOMIZED FORK — source: pi-coding-agent@0.84.3 examples/extensions/subagent/index.ts
 *
 * Local modifications (keep this list current when syncing with upstream):
 * 1. Optional `model` tool param (single top-level + per-item in tasks/chain),
 *    passed through to `pi --model` (supports "provider/id:level" suffix).
 * 2. `--thinking` is always passed with the session's current thinking level,
 *    unless the model override carries a ":level" suffix. (Upstream dropped
 *    thinking whenever an agent pinned a model.)
 * 3. Usage line renders "model:thinking" via formatModelWithThinking().
 * 4. Persistent child sessions with parentSession lineage, lightweight parent indexes,
 *    live JSON transcript reconstruction, and a fullscreen read-only viewer.
 * 5. Chinese user-facing UI and extension-generated messages; tool schemas,
 *    internal protocol values, and model-facing instructions remain English.
 *
 * agents.ts remains upstream-aligned unless intentionally changed.
 *
 * Sync after pi upgrades: locate the global npm root with `npm root -g`, diff against
 *   <npm-root>/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts
 * and re-apply the blocks above.
 * 1.5.0 sync: use formatReadLineRange() for numeric-string/null read ranges.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { getPiInvocation, persistentJsonArgs, runJsonChild } from "./child-process.ts";
import { formatAgentScope, formatAgentSource, formatStatus, formatStopReason } from "./localization.ts";
import {
	CHILD_INDEX_TYPE,
	type ChildIndexPayload,
	ChildSessionStore,
	type ChildSessionRef,
	foldChildIndexes,
	resolveResultChild,
	type SessionStorage,
	toDetailsResult,
} from "./child-session.ts";
import { PiSessionStorage } from "./session-storage.ts";
import { formatToolCall, ViewerController } from "./viewer.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} 轮`);
	if (usage.input) parts.push(`输入 ↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`输出 ↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`缓存读 ${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`缓存写 ${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`上下文:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

// Custom: render the usage line's model segment as "model:thinking" when we
// explicitly passed --thinking. A model override carrying its own ":level"
// suffix already shows the level, and `thinking` is undefined in that case.
function formatModelWithThinking(result: SingleResult): string | undefined {
	if (!result.model) return undefined;
	return result.thinking ? `${result.model}:${result.thinking}` : result.model;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: AgentMessage[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	child?: ChildSessionRef;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "（无输出）";
	}
	return getFinalOutput(result.messages) || "（无输出）";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[输出已截断：省略 ${byteLength - Buffer.byteLength(truncated, "utf8")} 字节。完整输出可在关联的子代理会话中查看。]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: AgentMessage[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface SubagentRuntime {
	storage: SessionStorage;
	children: ChildSessionStore;
	appendIndex(payload: ChildIndexPayload, dispatchScope: string): void;
}

async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	modelOverride: string | undefined,
	toolCallId: string,
	runtime: SubagentRuntime,
	dispatchScope: string,
	parentSession: string | undefined,
	taskIndex: number | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "无";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `未知子代理："${agentName}"。可用子代理：${available}。`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	// Alignment rule (custom): the child always runs the dispatching session's current
	// model and thinking level unless explicitly overridden by the `model` tool param
	// (or an agent frontmatter pin). A ":level" suffix on the override carries thinking.
	const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;
	const requested = modelOverride ?? agent.model;
	let modelArg: string | undefined;
	let thinkingArg: string | undefined = dispatchDefaults.thinkingLevel;
	if (requested) {
		modelArg = requested;
		if (THINKING_SUFFIX.test(requested)) thinkingArg = undefined;
	} else {
		modelArg = dispatchDefaults.model;
	}

	const runId = step !== undefined
		? `${toolCallId}:step:${step}`
		: taskIndex !== undefined
			? `${toolCallId}:task:${taskIndex}`
			: toolCallId;
	const childCwd = cwd ?? defaultCwd;
	let created: ReturnType<SessionStorage["create"]>;
	try {
		created = runtime.storage.create({ cwd: childCwd, parentSession });
	} catch (error) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			stderr: error instanceof Error ? error.message : String(error),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: modelArg,
			thinking: thinkingArg,
			step,
		};
	}
	const child: ChildSessionRef = {
		runId,
		toolCallId,
		sessionId: created.sessionId,
		sessionFile: created.sessionFile,
		agent: agent.name,
		description: task.split(/\s+/).slice(0, 8).join(" ") || agent.name,
		model: modelArg,
		thinking: thinkingArg,
		taskIndex,
		step,
	};
	runtime.children.start(child, dispatchScope);

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let terminalIndexAttempted = false;
	let settlementError: unknown;
	let hasSettlementError = false;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: modelArg,
		thinking: thinkingArg,
		step,
		child,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "（运行中…）" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		runtime.appendIndex({ ...child, status: "running" }, dispatchScope);
		const args = persistentJsonArgs({ sessionFile: child.sessionFile, sessionDir: runtime.storage.directory });
		if (modelArg) args.push("--model", modelArg);
		if (thinkingArg) args.push("--thinking", thinkingArg);
		if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		const result = await runJsonChild(getPiInvocation(args), {
			cwd: childCwd,
			signal,
			onEvent: (event) => {
				runtime.children.apply(runId, event, dispatchScope);
				const record = runtime.children.get(runId, dispatchScope);
				if (record) currentResult.messages = record.transcript.messages;
				if (event.type === "message_end" && event.message.role === "assistant") {
					const message = event.message;
					currentResult.usage.turns++;
					currentResult.usage.input += message.usage.input || 0;
					currentResult.usage.output += message.usage.output || 0;
					currentResult.usage.cacheRead += message.usage.cacheRead || 0;
					currentResult.usage.cacheWrite += message.usage.cacheWrite || 0;
					currentResult.usage.cost += message.usage.cost?.total || 0;
					currentResult.usage.contextTokens = message.usage.totalTokens || 0;
					if (!currentResult.model && message.model) currentResult.model = message.model;
					if (message.stopReason) currentResult.stopReason = message.stopReason;
					if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
				}
				emitUpdate();
			},
		});

		currentResult.exitCode = result.exitCode;
		currentResult.stderr = result.stderr;
		const status = result.aborted
			? "aborted"
			: result.exitCode !== 0 || currentResult.stopReason === "error"
				? "failed"
				: "completed";
		try {
			runtime.children.finish(runId, status, (currentResult.errorMessage ?? result.stderr) || undefined, dispatchScope);
		} catch (error) {
			settlementError = error;
			hasSettlementError = true;
		}
		try {
			terminalIndexAttempted = true;
			runtime.appendIndex({ ...child, status }, dispatchScope);
		} catch (error) {
			if (!hasSettlementError) {
				settlementError = error;
				hasSettlementError = true;
			}
		}
		if (result.aborted) throw new Error("子代理已中止");
		if (hasSettlementError) throw settlementError;
		return currentResult;
	} catch (error) {
		const record = runtime.children.get(runId, dispatchScope);
		if (record?.status === "running") {
			const status = signal?.aborted ? "aborted" : "failed";
			const errorMessage = error instanceof Error ? error.message : String(error);
			try {
				runtime.children.finish(runId, status, errorMessage || undefined, dispatchScope);
			} catch {
				/* Preserve the original execution error if settlement itself fails. */
			}
		}
		if (!terminalIndexAttempted) {
			const settledRecord = runtime.children.get(runId, dispatchScope);
			const status = settledRecord && settledRecord.status !== "running"
				? settledRecord.status
				: signal?.aborted ? "aborted" : "failed";
			terminalIndexAttempted = true;
			try {
				runtime.appendIndex({ ...child, status }, dispatchScope);
			} catch {
				/* Terminal persistence is best effort and must not mask the original error. */
			}
		}
		throw error;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override, e.g. 'provider/id' or 'provider/id:level'. Default: inherit the session's current model and thinking level.",
		}),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override, e.g. 'provider/id' or 'provider/id:level'. Default: inherit the session's current model and thinking level.",
		}),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(
		Type.String({
			description:
				"Model override for single mode, e.g. 'provider/id' or 'provider/id:level'. Default: inherit the session's current model and thinking level.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	const storage = new PiSessionStorage();
	const children = new ChildSessionStore();
	const viewer = new ViewerController(children);
	const pendingIndexes = new Map<string, ChildIndexPayload[]>();
	let activeParentScope: string | undefined;
	const appendIndex = (payload: ChildIndexPayload, dispatchScope: string): void => {
		if (activeParentScope === dispatchScope) {
			pi.appendEntry(CHILD_INDEX_TYPE, payload);
			return;
		}
		const pending = pendingIndexes.get(dispatchScope) ?? [];
		pending.push(payload);
		pendingIndexes.set(dispatchScope, pending);
	};
	const flushPendingIndexes = (scope: string, ctx: ExtensionContext): void => {
		const pending = pendingIndexes.get(scope);
		if (!pending || pending.length === 0) return;
		let flushError: unknown;
		let hasFlushError = false;
		while (pending.length > 0) {
			try {
				pi.appendEntry(CHILD_INDEX_TYPE, pending[0]!);
				pending.shift();
			} catch (error) {
				flushError = error;
				hasFlushError = true;
				break;
			}
		}
		if (pending.length === 0) pendingIndexes.delete(scope);
		if (hasFlushError) {
			const message = flushError instanceof Error ? flushError.message : String(flushError);
			ctx.ui.notify(
				`无法将 ${pending.length} 条待处理的子代理索引写入当前父会话：${message}。这些索引仍保留在队列中，只会在当前父会话内重试。`,
				"error",
			);
		}
	};
	const activateParent = (ctx: ExtensionContext): string => {
		const scope = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		activeParentScope = scope;
		children.activate(scope);
		flushPendingIndexes(scope, ctx);
		return scope;
	};
	let currentContext: ExtensionContext | undefined;
	const wrapChildLink = (component: Component, result: SingleResult): Component => {
		const child = result.child;
		if (!child) return component;
		return new MouseRegion(component, (event) => {
			if (event.type !== "click" || event.button !== "left" || event.alt || event.ctrl || event.shift) return undefined;
			if (!currentContext) return undefined;
			void viewer.open(child.runId, currentContext);
			return { handled: true };
		});
	};
	const runtime: SubagentRuntime = {
		storage,
		children,
		appendIndex,
	};

	pi.on("session_start", (_event, ctx) => {
		viewer.close();
		const scope = activateParent(ctx);
		currentContext = ctx;
		children.restore(foldChildIndexes(ctx.sessionManager.getEntries()), storage, scope);
	});

	pi.on("session_shutdown", () => {
		viewer.close();
		activeParentScope = undefined;
		currentContext = undefined;
	});

	pi.registerCommand("subagents", {
		description: "查看子代理会话",
		handler: async (_args, ctx) => {
			const scope = activateParent(ctx);
			const indexes = foldChildIndexes(ctx.sessionManager.getEntries());
			children.restore(indexes, storage, scope);
			const records = children.list(scope);
			if (records.length === 0) {
				ctx.ui.notify("暂无子代理会话", "info");
				return;
			}
			const labels = records.map((record, index) => `${index + 1}. ${record.agent}: ${record.description} [${formatStatus(record.status)}]`);
			const selected = await ctx.ui.select("子代理会话", labels);
			if (selected === undefined) return;
			const record = records[labels.indexOf(selected)];
			if (record) await viewer.open(record.runId, ctx);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "子代理",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			"Each subagent runs the session's current model and thinking level by default; pass model ('provider/id' or 'provider/id:level') only when the user explicitly requests a different model.",
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const dispatchScope = activateParent(ctx);
			const parentSession = ctx.sessionManager.getSessionFile();
			const agentScope = (params.agentScope ?? "user") as AgentScope;
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results: results.map(toDetailsResult),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name}（${formatAgentSource(a.source)}）`).join("，") || "无";
				return {
					content: [
						{
							type: "text",
							text: `参数无效：必须且只能选择一种执行模式。\n可用子代理：${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "（未知）";
					const ok = await ctx.ui.confirm(
						"运行项目级子代理？",
						`子代理：${names}\n来源：${dir}\n\n项目级子代理由仓库控制。请仅在信任该仓库时继续。`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "已取消：未批准运行项目级子代理。" }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						step.model,
						toolCallId,
						runtime,
						dispatchScope,
						parentSession,
						undefined,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `链式执行在第 ${i + 1} 步（${step.agent}）停止：${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "（无输出）" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `并行任务过多（${params.tasks.length} 个），最多允许 ${MAX_PARALLEL_TASKS} 个。`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `并行执行：已完成 ${done}/${allResults.length}，运行中 ${running}…` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						dispatchDefaults,
						agents,
						t.agent,
						t.task,
						t.cwd,
						t.model,
						toolCallId,
						runtime,
						dispatchScope,
						parentSession,
						index,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `失败${r.stopReason && r.stopReason !== "end" ? `（${formatStopReason(r.stopReason)}）` : ""}`
						: "已完成";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `并行执行：成功 ${successCount}/${results.length}\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					dispatchDefaults,
					agents,
					params.agent,
					params.task,
					params.cwd,
					params.model,
					toolCallId,
					runtime,
					dispatchScope,
					parentSession,
					undefined,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `子代理执行失败${result.stopReason ? `（${formatStopReason(result.stopReason)}）` : ""}：${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "（无输出）" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name}（${formatAgentSource(a.source)}）`).join("，") || "无";
			return {
				content: [{ type: "text", text: `参数无效。可用子代理：${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope = (args.agentScope ?? "user") as AgentScope;
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("子代理 ")) +
					theme.fg("accent", `链式执行（${args.chain.length} 个步骤）`) +
					theme.fg("muted", ` [${formatAgentScope(scope)}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `… 另有 ${args.chain.length - 3} 项`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("子代理 ")) +
					theme.fg("accent", `并行执行（${args.tasks.length} 个任务）`) +
					theme.fg("muted", ` [${formatAgentScope(scope)}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `… 另有 ${args.tasks.length - 3} 项`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("子代理 ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${formatAgentScope(scope)}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const persistedDetails = result.details as SubagentDetails | undefined;
			if (!persistedDetails || persistedDetails.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "（无输出）", 0, 0);
			}

			const transcriptErrors = new Map<SingleResult, string>();
			const details: SubagentDetails = {
				...persistedDetails,
				results: persistedDetails.results.map((r) => {
					if (!r.child || r.messages.length > 0) return r;
					const record = resolveResultChild(children, r);
					if (!record) {
						transcriptErrors.set(r, "子代理会话不可用");
						return r;
					}
					const hydrated = { ...r, messages: record.transcript.messages };
					if (record.error && record.transcript.messages.length === 0) transcriptErrors.set(hydrated, record.error);
					return hydrated;
				}),
			};

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `… 此前还有 ${skipped} 条记录\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);
				const transcriptError = transcriptErrors.get(r);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", `（${formatAgentSource(r.agentSource)}）`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${formatStopReason(r.stopReason)}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `错误：${r.errorMessage}`), 0, 0));
					if (transcriptError) container.addChild(new Text(theme.fg("error", transcriptError), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── 任务 ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── 输出 ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput && !transcriptError) {
						container.addChild(new Text(theme.fg("muted", "（无输出）"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, formatModelWithThinking(r));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return wrapChildLink(container, r);
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", `（${formatAgentSource(r.agentSource)}）`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${formatStopReason(r.stopReason)}]`)}`;
				if (isError && r.errorMessage) {
					text += `\n${theme.fg("error", `错误：${r.errorMessage}`)}`;
					if (transcriptError) text += `\n${theme.fg("error", transcriptError)}`;
				} else if (transcriptError) text += `\n${theme.fg("error", transcriptError)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "（无输出）")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "（按 Ctrl+O 展开）")}`;
				}
				const usageStr = formatUsageStats(r.usage, formatModelWithThinking(r));
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return wrapChildLink(new Text(text, 0, 0), r);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("链式执行 ")) +
								theme.fg("accent", `${successCount}/${details.results.length} 个步骤`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const transcriptError = transcriptErrors.get(r);
						const row = new Container();

						row.addChild(
							new Text(
								`${theme.fg("muted", `─── 第 ${r.step} 步：`) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						row.addChild(new Text(theme.fg("muted", "任务：") + theme.fg("dim", r.task), 0, 0));
						if (transcriptError) row.addChild(new Text(theme.fg("error", transcriptError), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								row.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							row.addChild(new Spacer(1));
							row.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, formatModelWithThinking(r));
						if (stepUsage) row.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
						container.addChild(new Spacer(1));
						container.addChild(wrapChildLink(row, r));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `总计：${usageStr}`), 0, 0));
					}
					return container;
				}

				// Preserve the original component for legacy results without child references.
				if (!details.results.some((r) => r.child)) {
					let text =
						icon +
						" " +
						theme.fg("toolTitle", theme.bold("链式执行 ")) +
						theme.fg("accent", `${successCount}/${details.results.length} 个步骤`);
					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						text += `\n\n${theme.fg("muted", `─── 第 ${r.step} 步：`)}${theme.fg("accent", r.agent)} ${rIcon}`;
						if (displayItems.length === 0) text += `\n${theme.fg("muted", "（无输出）")}`;
						else text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `总计：${usageStr}`)}`;
					text += `\n${theme.fg("muted", "（按 Ctrl+O 展开）")}`;
					return new Text(text, 0, 0);
				}

				const container = new Container();
				container.addChild(new Text(
					icon + " " + theme.fg("toolTitle", theme.bold("链式执行 ")) +
					theme.fg("accent", `${successCount}/${details.results.length} 个步骤`),
					0,
					0,
				));
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					const transcriptError = transcriptErrors.get(r);
					const row = new Container();
					row.addChild(new Text(
						`${theme.fg("muted", `─── 第 ${r.step} 步：`)}${theme.fg("accent", r.agent)} ${rIcon}`,
						0,
						0,
					));
					if (transcriptError) row.addChild(new Text(theme.fg("error", transcriptError), 0, 0));
					if (displayItems.length === 0 && !transcriptError) row.addChild(new Text(theme.fg("muted", "（无输出）"), 0, 0));
					else if (displayItems.length > 0) row.addChild(new Text(renderDisplayItems(displayItems, 5), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(wrapChildLink(row, r));
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `总计：${usageStr}`), 0, 0));
				}
				container.addChild(new Text(theme.fg("muted", "（按 Ctrl+O 展开）"), 0, 0));
				return container;
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `已完成 ${successCount + failCount}/${details.results.length}，运行中 ${running}`
					: `成功 ${successCount}/${details.results.length}`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("并行执行 "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);
						const transcriptError = transcriptErrors.get(r);
						const row = new Container();

						row.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						row.addChild(new Text(theme.fg("muted", "任务：") + theme.fg("dim", r.task), 0, 0));
						if (transcriptError) row.addChild(new Text(theme.fg("error", transcriptError), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								row.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							row.addChild(new Spacer(1));
							row.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, formatModelWithThinking(r));
						if (taskUsage) row.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
						container.addChild(new Spacer(1));
						container.addChild(wrapChildLink(row, r));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `总计：${usageStr}`), 0, 0));
					}
					return container;
				}

				// Preserve the original component for legacy results without child references.
				if (!details.results.some((r) => r.child)) {
					let text = `${icon} ${theme.fg("toolTitle", theme.bold("并行执行 "))}${theme.fg("accent", status)}`;
					for (const r of details.results) {
						const rIcon =
							r.exitCode === -1
								? theme.fg("warning", "⏳")
								: isFailedResult(r)
									? theme.fg("error", "✗")
									: theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
						if (displayItems.length === 0)
							text += `\n${theme.fg("muted", r.exitCode === -1 ? "（运行中…）" : "（无输出）")}`;
						else text += `\n${renderDisplayItems(displayItems, 5)}`;
					}
					if (!isRunning) {
						const usageStr = formatUsageStats(aggregateUsage(details.results));
						if (usageStr) text += `\n\n${theme.fg("dim", `总计：${usageStr}`)}`;
					}
					if (!expanded) text += `\n${theme.fg("muted", "（按 Ctrl+O 展开）")}`;
					return new Text(text, 0, 0);
				}

				const container = new Container();
				container.addChild(new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("并行执行 "))}${theme.fg("accent", status)}`,
					0,
					0,
				));
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					const transcriptError = transcriptErrors.get(r);
					const row = new Container();
					row.addChild(new Text(
						`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`,
						0,
						0,
					));
					if (transcriptError) row.addChild(new Text(theme.fg("error", transcriptError), 0, 0));
					if (displayItems.length === 0 && !transcriptError) {
						row.addChild(new Text(theme.fg("muted", r.exitCode === -1 ? "（运行中…）" : "（无输出）"), 0, 0));
					} else if (displayItems.length > 0) row.addChild(new Text(renderDisplayItems(displayItems, 5), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(wrapChildLink(row, r));
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `总计：${usageStr}`), 0, 0));
					}
				}
				if (!expanded) container.addChild(new Text(theme.fg("muted", "（按 Ctrl+O 展开）"), 0, 0));
				return container;
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "（无输出）", 0, 0);
		},
	});
}
