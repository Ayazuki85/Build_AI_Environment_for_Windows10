import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildCodeCopyHeader,
	type CodeBlock,
	CodeBlockRegistry,
	COPY_LINK_SCHEME,
	copyNativeWith,
	createOsc52,
	evaluateCopyOutcome,
	LifecycleGeneration,
} from "./code-copy-core.ts";
import {
	installSharedPatch,
	type SharedPatchState,
	uninstallSharedPatch,
} from "./patch-lifecycle.ts";

const WIDGET_KEY = "markdown-preview-code-copy";
const LINK_PATCH_STATE = Symbol.for("pi-agent-beautify.code-copy.open-url");
const COPIED_MS = 2000;
const WL_COPY_TIMEOUT_MS = 3000;

function isWsl(env: NodeJS.ProcessEnv): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

/** Non-WSL headless Linux has no Pi native route; its success would only mean OSC 52. */
function hasPotentialPiNativeRoute(platform: string, env: NodeJS.ProcessEnv, wsl: boolean): boolean {
	if (platform !== "linux") return true;
	if (env.TERMUX_VERSION || env.WAYLAND_DISPLAY || env.DISPLAY) return true;
	// Preserve Pi's WSLg / Windows Terminal / PowerShell clipboard behavior.
	return wsl;
}

/** Pi resolves for either a native write or its own OSC 52 fallback in these environments. */
function piCopySuccessIsNative(
	platform: string,
	env: NodeJS.ProcessEnv,
	wsl: boolean,
	osc52Possible: boolean,
): boolean {
	// If OSC 52 exceeds its limit, a resolved Pi copy necessarily used a native route.
	if (!osc52Possible) return true;
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION || env.PI_CLIPBOARD_OSC52 === "1") return false;
	if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION) return false;
	// Windows Terminal is Pi's preferred WSL fallback before PowerShell.
	if (platform === "linux" && wsl && env.WT_SESSION) return false;
	return true;
}

type Timer = ReturnType<typeof setTimeout>;
type OpenUrl = (this: unknown, url: string) => void;
type LinkTarget = Record<PropertyKey, unknown> & { requestRender?: () => void };
type CopyLinkState = SharedPatchState<OpenUrl> & { owner?: CodeCopyController };

/**
 * Pi's stable TUI proxy creates a fresh forwarding function on every method read. Resolve its
 * current concrete renderer with a temporary unique method so identity-based patching happens on
 * the renderer itself. The probe removes itself from that concrete renderer before returning.
 */
function resolveConcreteLinkTarget(target: LinkTarget): LinkTarget | undefined {
	const probeKey = Symbol("markdown-preview-code-copy-concrete-target");
	const resolved: { target?: LinkTarget } = {};
	const probe = function (this: LinkTarget): void {
		resolved.target = this;
	};
	if (!Reflect.set(target, probeKey, probe)) return undefined;
	try {
		const forwarded = Reflect.get(target, probeKey);
		if (typeof forwarded !== "function") return undefined;
		Reflect.apply(forwarded, target, []);
		return resolved.target;
	} catch {
		return undefined;
	} finally {
		Reflect.deleteProperty(resolved.target ?? target, probeKey);
	}
}

export interface CodeCopyDependencies {
	piCopy: (text: string) => Promise<void>;
	measure: (text: string) => number;
	link: (text: string, url: string) => string;
	spawnProcess?: typeof spawn;
	writeStdout?: (sequence: string) => void;
	platform?: string;
	env?: NodeJS.ProcessEnv;
	setTimeout?: (callback: () => void, ms: number) => Timer;
	clearTimeout?: (timer: Timer) => void;
}

interface ResolvedDependencies extends CodeCopyDependencies {
	spawnProcess: typeof spawn;
	writeStdout: (sequence: string) => void;
	platform: string;
	env: NodeJS.ProcessEnv;
	setTimeout: (callback: () => void, ms: number) => Timer;
	clearTimeout: (timer: Timer) => void;
}

function waylandCopy(text: string, spawnProcess: typeof spawn): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: Timer | undefined;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnProcess("wl-copy", ["--type", "text/plain;charset=utf-8"], {
				stdio: ["pipe", "ignore", "ignore"],
			});
		} catch {
			resolve(false);
			return;
		}
		const done = (ok: boolean) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve(ok);
		};
		child.once("error", () => done(false));
		child.once("exit", (code) => done(code === 0));
		if (!child.stdin) {
			child.kill();
			done(false);
			return;
		}
		child.stdin.once("error", () => done(false));
		child.stdin.end(text);
		timer = setTimeout(() => {
			child.kill();
			done(false);
		}, WL_COPY_TIMEOUT_MS);
		timer.unref?.();
	});
}

export class CodeCopyController {
	private readonly registry = new CodeBlockRegistry();
	private readonly generation = new LifecycleGeneration();
	private readonly deps: ResolvedDependencies;
	private ctx: ExtensionContext | undefined;
	/** Stable Pi proxy used for repaints and current-mode/state observation. */
	private linkTarget: LinkTarget | undefined;
	/** Concrete renderer on which the identity-based URL patch is installed. */
	private patchTarget: LinkTarget | undefined;
	private linkState: CopyLinkState | undefined;
	private clickable = false;
	private copiedKey: string | undefined;
	private copiedTimer: Timer | undefined;
	private osc52Warned = false;
	private version = 0;

	constructor(dependencies: CodeCopyDependencies) {
		this.deps = {
			...dependencies,
			spawnProcess: dependencies.spawnProcess ?? spawn,
			writeStdout: dependencies.writeStdout ?? ((sequence) => process.stdout.write(sequence)),
			platform: dependencies.platform ?? process.platform,
			env: dependencies.env ?? process.env,
			setTimeout: dependencies.setTimeout ?? ((callback, ms) => setTimeout(callback, ms)),
			clearTimeout: dependencies.clearTimeout ?? ((timer) => clearTimeout(timer)),
		};
	}

	get renderVersion(): number {
		return this.version;
	}

	renderHeader(block: CodeBlock, width: number, border: (text: string) => string): string {
		if (!this.generation.isActive) return "";
		this.reconcileLinkTarget();
		const key = this.registry.remember(block);
		return buildCodeCopyHeader(
			{ width, key, copied: this.copiedKey === key, clickable: this.clickable },
			{
				measure: this.deps.measure,
				link: this.deps.link,
				style: (text) => border(text),
			},
		);
	}

	activate(ctx: ExtensionContext): void {
		if (!this.generation.isActive) return;
		this.ctx = ctx;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			const empty = {
				render: () => {
					this.reconcileLinkTarget();
					return [];
				},
				invalidate: () => {},
			};
			if (!this.generation.isActive) return empty;
			this.linkTarget = tui as unknown as LinkTarget;
			this.reconcileLinkTarget();
			return empty;
		});
	}

	/** Reconcile the stable proxy with the concrete renderer currently beneath it. */
	reconcileLinkTarget(): void {
		if (!this.generation.isActive || !this.linkTarget) return;
		const proxy = this.linkTarget;
		try {
			const mode = Reflect.get(proxy, "mode");
			const openUrl = Reflect.get(proxy, "openUrl");
			// Plain test/adapter TUIs predate the mode property; real regular Pi renderers have no openUrl.
			const canIntercept = mode === "fullscreen" || (mode === undefined && typeof openUrl === "function");
			if (!canIntercept) {
				this.loseInterception();
				return;
			}
			if (this.clickable && this.patchTarget && this.linkState
				&& Reflect.get(proxy, LINK_PATCH_STATE) === this.linkState) return;
		} catch {
			this.loseInterception();
			return;
		}

		// A renderer replacement loses the old interception even when the next target is fullscreen too.
		this.loseInterception();
		try {
			const concrete = resolveConcreteLinkTarget(proxy);
			if (!concrete || typeof Reflect.get(concrete, "openUrl") !== "function") return;
			const state = installSharedPatch<OpenUrl>(concrete, "openUrl", LINK_PATCH_STATE, (original, patch) =>
				function (this: unknown, url: string): void {
					const linkState = patch as CopyLinkState;
					if (!patch.active || !url.startsWith(COPY_LINK_SCHEME)) return original.call(this, url);
					void linkState.owner?.copyUrl(url);
				},
			) as CopyLinkState;
			state.owner = this;
			this.patchTarget = concrete;
			this.linkState = state;
			this.clickable = true;
			this.bumpVersion();
		} catch {
			this.loseInterception();
		}
	}

	async copyUrl(url: string): Promise<void> {
		if (!this.generation.isActive || !url.startsWith(COPY_LINK_SCHEME)) return;
		const key = url.slice(COPY_LINK_SCHEME.length);
		const block = this.registry.get(key);
		if (!block) {
			this.ctx?.ui.notify("Copy failed: this code block is no longer cached", "error");
			return;
		}
		const token = this.generation.current;
		const sequence = createOsc52(block.code);
		const platform = this.deps.platform;
		const env = this.deps.env;
		const wsl = platform === "linux" && isWsl(env);
		const piNativeConfirmed = piCopySuccessIsNative(platform, env, wsl, sequence !== undefined);
		let waylandSucceeded = false;
		const native = hasPotentialPiNativeRoute(platform, env, wsl)
			? await copyNativeWith(block.code, {
				platform,
				wayland: Boolean(env.WAYLAND_DISPLAY),
				wlCopy: async (text) => {
					waylandSucceeded = await waylandCopy(text, this.deps.spawnProcess);
					return waylandSucceeded;
				},
				piCopy: this.deps.piCopy,
			})
			: false;
		if (!this.generation.isCurrent(token)) return;
		const nativeConfirmed = native && (waylandSucceeded || piNativeConfirmed);

		let terminal = false;
		if (sequence !== undefined) {
			try {
				this.deps.writeStdout(sequence);
				terminal = true;
			} catch {
				terminal = false;
			}
		}
		const outcome = evaluateCopyOutcome(native, terminal);
		if (outcome === "failed") {
			this.ctx?.ui.notify("Copy failed: system clipboard and OSC 52 are unavailable", "error");
			return;
		}
		if (!nativeConfirmed && !this.osc52Warned) {
			this.osc52Warned = true;
			const message = outcome === "terminal-only"
				? "Copied via terminal OSC 52 only; install a system clipboard tool if paste fails"
				: "Copy succeeded but is not system-confirmed; OSC 52 may have been used; install a system clipboard tool if paste fails";
			this.ctx?.ui.notify(message, "warning");
		}
		this.markCopied(key, token);
	}

	deactivate(): void {
		if (!this.generation.isActive) return;
		this.generation.invalidate();
		if (this.copiedTimer !== undefined) this.deps.clearTimeout(this.copiedTimer);
		this.copiedTimer = undefined;
		this.clearLinkPatch();
		if (this.ctx?.mode === "tui") this.ctx.ui.setWidget(WIDGET_KEY, undefined);
		this.registry.clear();
		this.copiedKey = undefined;
		this.clickable = false;
		this.osc52Warned = false;
		this.linkTarget = undefined;
		this.ctx = undefined;
	}

	private clearLinkPatch(): void {
		if (this.patchTarget) {
			uninstallSharedPatch(this.patchTarget, "openUrl", LINK_PATCH_STATE);
			const state = Reflect.get(this.patchTarget, LINK_PATCH_STATE) as CopyLinkState | undefined;
			if (state?.owner === this) state.owner = undefined;
		}
		this.patchTarget = undefined;
		this.linkState = undefined;
		this.clickable = false;
	}

	private loseInterception(): void {
		const hadInterception = this.clickable || this.patchTarget !== undefined;
		this.clearLinkPatch();
		if (hadInterception) this.bumpVersion();
	}

	private markCopied(key: string, token: number): void {
		if (!this.generation.isCurrent(token)) return;
		if (this.copiedTimer !== undefined) this.deps.clearTimeout(this.copiedTimer);
		this.copiedKey = key;
		this.bumpVersion();
		let timer: Timer;
		timer = this.deps.setTimeout(() => {
			if (!this.generation.isCurrent(token) || this.copiedTimer !== timer) return;
			this.copiedTimer = undefined;
			this.copiedKey = undefined;
			this.bumpVersion();
		}, COPIED_MS);
		this.copiedTimer = timer;
		timer.unref?.();
	}

	private bumpVersion(): void {
		this.version++;
		this.linkTarget?.requestRender?.();
	}
}
