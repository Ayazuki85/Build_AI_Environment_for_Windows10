import { createHash } from "node:crypto";

export const COPY_LINK_SCHEME = "pi-md-preview-copy:";
export const MAX_REGISTRY = 500;
export const MAX_OSC52_ENCODED_LENGTH = 100_000;

export interface CodeBlock {
	lang: string;
	code: string;
}

export function hashCodeBlock(block: CodeBlock): string {
	return createHash("sha256").update(block.lang).update("\0").update(block.code).digest("hex");
}

export class CodeBlockRegistry {
	private readonly blocks = new Map<string, CodeBlock>();
	readonly maxEntries: number;

	constructor(maxEntries = MAX_REGISTRY) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
		this.maxEntries = maxEntries;
	}

	get size(): number {
		return this.blocks.size;
	}

	remember(block: CodeBlock): string {
		const stored = { lang: block.lang, code: block.code };
		const key = hashCodeBlock(stored);
		this.blocks.delete(key);
		this.blocks.set(key, stored);
		while (this.blocks.size > this.maxEntries) {
			const oldest = this.blocks.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.blocks.delete(oldest);
		}
		return key;
	}

	get(key: string): CodeBlock | undefined {
		return this.blocks.get(key);
	}

	clear(): void {
		this.blocks.clear();
	}
}

export function createOsc52(text: string): string | undefined {
	const encoded = Buffer.from(text, "utf8").toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) return undefined;
	return `\x1b]52;c;${encoded}\x07`;
}

export type CopyOutcome = "native" | "terminal-only" | "failed";

export function evaluateCopyOutcome(native: boolean, terminal: boolean): CopyOutcome {
	if (native) return "native";
	if (terminal) return "terminal-only";
	return "failed";
}

export interface NativeCopyDependencies {
	platform: string;
	wayland: boolean;
	wlCopy: (text: string) => Promise<boolean>;
	piCopy: (text: string) => Promise<void>;
}

export async function copyNativeWith(text: string, dependencies: NativeCopyDependencies): Promise<boolean> {
	if (dependencies.platform === "linux" && dependencies.wayland) {
		try {
			if (await dependencies.wlCopy(text)) return true;
		} catch {
			// Fall through to Pi's clipboard implementation.
		}
	}
	try {
		await dependencies.piCopy(text);
		return true;
	} catch {
		return false;
	}
}

export class LifecycleGeneration {
	private generation = 0;
	private active = true;

	get current(): number {
		return this.generation;
	}

	get isActive(): boolean {
		return this.active;
	}

	invalidate(): void {
		if (!this.active) return;
		this.active = false;
		this.generation++;
	}

	isCurrent(token: number): boolean {
		return this.active && token === this.generation;
	}
}

export interface CopyHeaderOptions {
	width: number;
	key: string;
	copied: boolean;
	clickable: boolean;
}

export interface CopyHeaderAdapter {
	measure: (text: string) => number;
	link: (text: string, url: string) => string;
	style?: (text: string, copied: boolean) => string;
}

export function buildCodeCopyHeader(options: CopyHeaderOptions, adapter: CopyHeaderAdapter): string {
	if (!options.clickable) return "";
	const label = options.copied ? " ✓ Copied " : " ⧉ copy ";
	const labelWidth = adapter.measure(label);
	const width = Math.max(0, Math.floor(options.width));
	if (width < labelWidth) return "";
	const styled = adapter.style?.(label, options.copied) ?? label;
	// Keep the success label linked so another click copies again and restarts the timer.
	const linked = adapter.link(styled, `${COPY_LINK_SCHEME}${options.key}`);
	return " ".repeat(width - labelWidth) + linked;
}
