import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ToolExecutionState {
	toolCallId: string;
	toolName: string;
	status: "running" | "completed" | "failed";
	args?: Record<string, unknown>;
	partialResult?: AgentToolResult;
	result?: AgentToolResult;
}

export class TranscriptAccumulator {
	readonly messages: AgentMessage[] = [];
	readonly revisions: number[] = [];
	readonly tools = new Map<string, ToolExecutionState>();
	private activeMessageIndex: number | undefined;
	private readonly toolArgumentDrafts = new Map<number, string>();
	private readonly finalizedMessageKeys = new Set<string>();

	replaceAll(messages: readonly AgentMessage[]): void {
		this.messages.splice(0, this.messages.length, ...messages);
		this.revisions.splice(0, this.revisions.length, ...messages.map(() => 0));
		this.tools.clear();
		this.toolArgumentDrafts.clear();
		this.finalizedMessageKeys.clear();
		for (const message of messages) {
			this.finalizedMessageKeys.add(JSON.stringify(message));
			if (message.role === "assistant") {
				for (const part of message.content) {
					if (part.type !== "toolCall") continue;
					this.tools.set(part.id, {
						toolCallId: part.id,
						toolName: part.name,
						status: "running",
						args: part.arguments,
					});
				}
			} else if (message.role === "toolResult") {
				const tool = this.tools.get(message.toolCallId);
				if (!tool) continue;
				tool.status = message.isError ? "failed" : "completed";
				tool.result = {
					content: message.content,
					details: message.details,
					isError: message.isError,
				};
			}
		}
		this.activeMessageIndex = undefined;
	}

	apply(event: JsonAgentSessionEvent): boolean {
		switch (event.type) {
			case "message_start":
				this.messages.push(event.message);
				this.revisions.push(0);
				this.activeMessageIndex = this.messages.length - 1;
				return true;
			case "message_end": {
				const key = JSON.stringify(event.message);
				if (this.activeMessageIndex === undefined) {
					if (this.finalizedMessageKeys.has(key)) return false;
					this.messages.push(event.message);
					this.revisions.push(0);
				} else {
					this.messages[this.activeMessageIndex] = event.message;
					this.revisions[this.activeMessageIndex] = (this.revisions[this.activeMessageIndex] ?? 0) + 1;
				}
				this.finalizedMessageKeys.add(key);
				this.activeMessageIndex = undefined;
				this.toolArgumentDrafts.clear();
				return true;
			}
			case "message_update": {
				const message = this.activeAssistant();
				if (!message) return false;
				message.usage = event.usage;
				this.applyAssistantDelta(message, event.assistantMessageEvent);
				this.revisions[this.activeMessageIndex!] = (this.revisions[this.activeMessageIndex!] ?? 0) + 1;
				return true;
			}
			case "tool_execution_start":
				this.tools.set(event.toolCallId, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					status: "running",
					args: event.args,
				});
				return true;
			case "tool_execution_update": {
				const tool = this.tools.get(event.toolCallId);
				if (!tool) return false;
				tool.partialResult = event.partialResult;
				return true;
			}
			case "tool_execution_end": {
				const tool = this.tools.get(event.toolCallId) ?? {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					status: "running" as const,
				};
				tool.result = event.result;
				tool.status = event.isError ? "failed" : "completed";
				this.tools.set(event.toolCallId, tool);
				return true;
			}
			default:
				return false;
		}
	}

	private activeAssistant(): AssistantMessage | undefined {
		const message = this.activeMessageIndex === undefined ? undefined : this.messages[this.activeMessageIndex];
		return message?.role === "assistant" ? message : undefined;
	}

	private applyAssistantDelta(
		message: AssistantMessage,
		event: Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
	): void {
		if (!("contentIndex" in event)) return;
		const index = event.contentIndex;
		switch (event.type) {
			case "text_start":
				message.content[index] = { type: "text", text: "" };
				return;
			case "text_delta": {
				const part = message.content[index];
				if (part?.type === "text") part.text += event.delta;
				return;
			}
			case "text_end":
				message.content[index] = { type: "text", text: event.content };
				return;
			case "thinking_start":
				message.content[index] = { type: "thinking", thinking: "" };
				return;
			case "thinking_delta": {
				const part = message.content[index];
				if (part?.type === "thinking") part.thinking += event.delta;
				return;
			}
			case "thinking_end":
				message.content[index] = { type: "thinking", thinking: event.content };
				return;
			case "toolcall_start":
				message.content[index] = { type: "toolCall", id: event.id, name: event.toolName, arguments: {} };
				this.toolArgumentDrafts.set(index, "");
				return;
			case "toolcall_delta":
				this.toolArgumentDrafts.set(index, (this.toolArgumentDrafts.get(index) ?? "") + event.delta);
				return;
			case "toolcall_end":
				message.content[index] = event.toolCall;
				this.toolArgumentDrafts.delete(index);
				return;
		}
	}
}

export function truncateUtf8(text: string, maxBytes: number): string {
	const textBytes = Buffer.byteLength(text, "utf8");
	if (textBytes <= maxBytes) return text;
	let result = "";
	let resultBytes = 0;
	for (const codePoint of text) {
		const codePointBytes = Buffer.byteLength(codePoint, "utf8");
		if (resultBytes + codePointBytes > maxBytes) break;
		result += codePoint;
		resultBytes += codePointBytes;
	}
	return `${result}\n\n[输出已截断：省略 ${textBytes - resultBytes} 字节。]`;
}
