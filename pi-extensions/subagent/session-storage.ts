import { existsSync, statSync } from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionStorage } from "./child-session.ts";

export class PiSessionStorage implements SessionStorage {
	readonly directory = path.join(getAgentDir(), "subagent", "sessions");

	create(input: { cwd: string; parentSession?: string }): { sessionId: string; sessionFile: string } {
		const manager = SessionManager.create(input.cwd, this.directory, { parentSession: input.parentSession });
		// Flush the header before the child opens this explicit path, then omit the bootstrap from model context.
		const bootstrapId = manager.appendMessage({ role: "user", content: "", timestamp: Date.now() });
		manager.appendContextEdit(bootstrapId, null);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("无法创建持久化子代理会话文件");
		return { sessionId: manager.getSessionId(), sessionFile };
	}

	read(sessionFile: string): AgentMessage[] {
		if (!existsSync(sessionFile)) throw new Error(`未找到子代理会话文件：${sessionFile}`);
		if (statSync(sessionFile).size === 0) throw new Error(`子代理会话文件无效或为空：${sessionFile}`);
		const branch = SessionManager.open(sessionFile).getBranch();
		const firstMessage = branch.find((entry) => entry.type === "message");
		const bootstrapId = firstMessage?.type === "message" &&
			firstMessage.message.role === "user" && firstMessage.message.content === "" &&
			branch.some((entry) => entry.type === "context_edit" && entry.targetId === firstMessage.id && entry.replacement === null)
			? firstMessage.id
			: undefined;
		// The viewer is a raw active-branch archive, not the model's compaction/edit projection.
		return branch.flatMap((entry) => entry.type === "message" && entry.id !== bootstrapId ? [entry.message] : []);
	}
}
