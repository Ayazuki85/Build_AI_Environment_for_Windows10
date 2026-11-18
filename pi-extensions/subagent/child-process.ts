import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface ChildInvocation {
	command: string;
	args: string[];
}

export interface ChildProcessResult {
	exitCode: number;
	stderr: string;
	aborted: boolean;
}

export function persistentJsonArgs(input: { sessionFile: string; sessionDir: string }): string[] {
	return ["--mode", "json", "-p", "--session", input.sessionFile, "--session-dir", input.sessionDir];
}

export function getPiInvocation(args: string[]): ChildInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export async function runJsonChild(
	invocation: ChildInvocation,
	options: {
		cwd: string;
		signal?: AbortSignal;
		onEvent: (event: JsonAgentSessionEvent) => void;
	},
	dependencies: { spawn?: typeof spawn } = {},
): Promise<ChildProcessResult> {
	return new Promise((resolve, reject) => {
		const spawnChild = dependencies.spawn ?? spawn;
		const proc = spawnChild(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const decoder = new TextDecoder();
		let buffer = "";
		let stderr = "";
		let aborted = false;
		let settled = false;
		let consumerFailed = false;
		let consumerError: unknown;
		let terminating = false;
		let killTimer: NodeJS.Timeout | undefined;

		const processLine = (line: string) => {
			const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (!normalized.trim()) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(normalized);
			} catch {
				return; // Only malformed JSON is ignored; consumer errors are handled by the caller.
			}
			options.onEvent(parsed as JsonAgentSessionEvent);
		};
		const cleanup = () => {
			if (killTimer) clearTimeout(killTimer);
			killTimer = undefined;
			options.signal?.removeEventListener("abort", abort);
		};
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (consumerFailed) reject(consumerError);
			else resolve({ exitCode, stderr, aborted });
		};
		const terminate = () => {
			if (terminating || settled) return;
			terminating = true;
			proc.kill("SIGTERM");
			if (settled) return;
			killTimer = setTimeout(() => {
				if (!settled) proc.kill("SIGKILL");
			}, 5000);
			killTimer.unref();
		};
		const failConsumer = (error: unknown, terminateChild: boolean) => {
			if (consumerFailed || settled) return;
			consumerFailed = true;
			consumerError = error;
			if (terminateChild) terminate();
		};
		const abort = () => {
			aborted = true;
			terminate();
		};

		proc.stdout.on("data", (data) => {
			if (settled || consumerFailed) return;
			buffer += decoder.decode(data, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				try {
					processLine(line);
				} catch (error) {
					failConsumer(error, true);
					break;
				}
			}
		});
		proc.stderr.on("data", (data) => { stderr += data.toString(); });
		proc.on("error", (error) => {
			if (settled) return;
			stderr += `${stderr ? "\n" : ""}${error.message}`;
			finish(1);
		});
		proc.on("close", (code) => {
			if (settled) return;
			buffer += decoder.decode();
			if (buffer.trim() && !consumerFailed) {
				try {
					processLine(buffer);
				} catch (error) {
					failConsumer(error, false);
				}
			}
			finish(code ?? 0);
		});
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
	});
}
