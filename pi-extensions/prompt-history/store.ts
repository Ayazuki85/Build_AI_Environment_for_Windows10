import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface StoreOptions {
	softCap?: number;
	compactThreshold?: number;
	checkEvery?: number;
}

export function resolveHistoryPath(): string {
	try {
		const dir = dirname(fileURLToPath(import.meta.url));
		if (dir) return join(dir, "history.jsonl");
	} catch {
		// fall through to agent-dir fallback
	}
	return join(homedir(), ".pi", "agent", "prompt-history.jsonl");
}

export function readEntries(path: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const line of raw.split("\n")) {
		if (!line) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (typeof value === "string" && value.trim()) out.push(value);
		} catch {
			// skip corrupt line
		}
	}
	return out;
}

export class HistoryStore {
	private path: string;
	private softCap: number;
	private compactThreshold: number;
	private checkEvery: number;
	private last: string | null | undefined;
	private appendsSinceCheck = 0;

	constructor(path: string, options: StoreOptions = {}) {
		this.path = path;
		this.softCap = options.softCap ?? 1000;
		this.compactThreshold = options.compactThreshold ?? 1200;
		this.checkEvery = options.checkEvery ?? 50;
	}

	append(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (trimmed === this.lastEntry()) return;
		appendFileSync(this.path, `${JSON.stringify(trimmed)}\n`, "utf8");
		this.last = trimmed;
		this.compactIfNeeded();
	}

	recent(limit: number): string[] {
		return readEntries(this.path).slice(-limit);
	}

	private lastEntry(): string | null {
		if (this.last === undefined) {
			const entries = readEntries(this.path);
			this.last = entries.length > 0 ? entries[entries.length - 1] : null;
		}
		return this.last;
	}

	private compactIfNeeded(): void {
		this.appendsSinceCheck += 1;
		if (this.appendsSinceCheck < this.checkEvery) return;
		this.appendsSinceCheck = 0;
		const entries = readEntries(this.path);
		if (entries.length <= this.compactThreshold) return;
		const seen = new Set<string>();
		const kept: string[] = [];
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (!seen.has(entry)) {
				seen.add(entry);
				kept.push(entry);
			}
		}
		kept.reverse();
		const final = kept.slice(-this.softCap);
		const tmp = `${this.path}.tmp`;
		writeFileSync(tmp, final.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
		renameSync(tmp, this.path);
		this.last = final.length > 0 ? final[final.length - 1] : null;
	}
}
