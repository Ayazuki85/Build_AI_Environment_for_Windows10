import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonAgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { TranscriptAccumulator } from "./transcript.ts";

export const CHILD_INDEX_TYPE = "pi-subagent-child";
export type ChildStatus = "running" | "completed" | "failed" | "aborted" | "unknown";

export interface ChildSessionRef {
	runId: string;
	toolCallId: string;
	sessionId: string;
	sessionFile: string;
	agent: string;
	description: string;
	model?: string;
	thinking?: string;
	taskIndex?: number;
	step?: number;
}

export interface ChildIndexPayload extends ChildSessionRef { status: ChildStatus }

export interface ChildSessionRecord extends ChildSessionRef {
	status: ChildStatus;
	transcript: TranscriptAccumulator;
	error?: string;
}

export interface SessionStorage {
	readonly directory: string;
	create(input: { cwd: string; parentSession?: string }): { sessionId: string; sessionFile: string };
	read(sessionFile: string): AgentMessage[];
}

export class ChildSessionStore {
	private readonly records = new Map<string, Map<string, ChildSessionRecord>>();
	private readonly listeners = new Map<string, Map<string, Set<() => void>>>();
	private activeScope = "";

	activate(scope: string): void { this.activeScope = scope; }

	start(ref: ChildSessionRef, scope = this.activeScope): ChildSessionRecord {
		let scoped = this.records.get(scope);
		if (!scoped) {
			scoped = new Map<string, ChildSessionRecord>();
			this.records.set(scope, scoped);
		}
		const existing = scoped.get(ref.runId);
		if (existing) return existing;
		const record: ChildSessionRecord = { ...ref, status: "running", transcript: new TranscriptAccumulator() };
		scoped.set(ref.runId, record);
		this.emit(record.runId, scope);
		return record;
	}

	apply(runId: string, event: JsonAgentSessionEvent, scope = this.activeScope): void {
		const record = this.records.get(scope)?.get(runId);
		if (!record) return;
		record.transcript.apply(event);
		this.emit(runId, scope);
	}

	finish(runId: string, status: ChildStatus, error?: string, scope = this.activeScope): void {
		const record = this.records.get(scope)?.get(runId);
		if (!record || record.status !== "running") return;
		record.status = status;
		if (status !== "completed" && error) record.error = error;
		this.emit(runId, scope);
	}

	get(runId: string, scope = this.activeScope): ChildSessionRecord | undefined {
		return this.records.get(scope)?.get(runId);
	}

	list(scope = this.activeScope): ChildSessionRecord[] {
		return [...(this.records.get(scope)?.values() ?? [])];
	}

	subscribe(runId: string, listener: () => void, scope = this.activeScope): () => void {
		let scoped = this.listeners.get(scope);
		if (!scoped) {
			scoped = new Map<string, Set<() => void>>();
			this.listeners.set(scope, scoped);
		}
		const listeners = scoped.get(runId) ?? new Set<() => void>();
		listeners.add(listener);
		scoped.set(runId, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				scoped.delete(runId);
				if (scoped.size === 0) this.listeners.delete(scope);
			}
		};
	}

	restore(indexes: readonly ChildIndexPayload[], storage: SessionStorage, scope = this.activeScope): void {
		for (const index of indexes) {
			if (this.records.get(scope)?.has(index.runId)) continue;
			const { status, ...ref } = index;
			const record = this.start(ref, scope);
			record.status = status === "running" ? "unknown" : status;
			try {
				record.transcript.replaceAll(storage.read(index.sessionFile));
			} catch (error) {
				record.error = error instanceof Error ? error.message : String(error);
			}
			this.emit(index.runId, scope);
		}
	}

	private emit(runId: string, scope: string): void {
		for (const listener of this.listeners.get(scope)?.get(runId) ?? []) {
			try {
				listener();
			} catch {
				// A viewer/UI subscriber must not corrupt the execution state machine.
			}
		}
	}
}

export function resolveResultChild(
	store: ChildSessionStore,
	result: { messages: unknown[]; child?: ChildSessionRef },
): ChildSessionRecord | undefined {
	return result.child ? store.get(result.child.runId) : undefined;
}

export function toDetailsResult<T extends { messages: unknown[] }>(
	result: T,
): Omit<T, "messages"> & { messages: never[] } {
	return { ...result, messages: [] };
}

export function foldChildIndexes(entries: readonly SessionEntry[]): ChildIndexPayload[] {
	const folded = new Map<string, ChildIndexPayload>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CHILD_INDEX_TYPE) continue;
		const value = entry.data as Partial<ChildIndexPayload> | undefined;
		if (!value || typeof value.runId !== "string" || typeof value.toolCallId !== "string" ||
			typeof value.sessionId !== "string" || typeof value.sessionFile !== "string" ||
			typeof value.agent !== "string" || typeof value.description !== "string") continue;
		if (value.model !== undefined && typeof value.model !== "string") continue;
		if (value.thinking !== undefined && typeof value.thinking !== "string") continue;
		if (value.taskIndex !== undefined && typeof value.taskIndex !== "number") continue;
		if (value.step !== undefined && typeof value.step !== "number") continue;
		if (!["running", "completed", "failed", "aborted", "unknown"].includes(value.status ?? "")) continue;
		folded.set(value.runId, value as ChildIndexPayload);
	}
	return [...folded.values()];
}
