import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	formatReadLineRange,
	getMarkdownTheme,
	getPackageDir,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	type KeybindingsManager,
	Markdown,
	ScrollView,
	Text,
	type TUI,
	type TuiMouseEvent,
	VStack,
} from "@earendil-works/pi-tui";
import type { TuiMouseDispatchResult } from "@earendil-works/pi-tui/dist/tui.js";
import type { LayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { ChildSessionRecord, ChildSessionStore } from "./child-session.ts";
import { formatStatus } from "./localization.ts";
import { truncateUtf8 } from "./transcript.ts";

// Pi's extension loader aliases only the pi-tui root entry, not internal subpaths.
// Resolve layout through the host's native package resolver instead of jiti.
type PiLayoutModule = typeof import("@earendil-works/pi-tui/dist/layout.js");
const hostRequire = createRequire(path.join(getPackageDir(), "package.json"));
const { getScrollViewsAt, renderLayoutFrame } = hostRequire(
	"@earendil-works/pi-tui/dist/layout.js",
) as PiLayoutModule;

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", `（${lines} 行）`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", `（位于 ${shortenPath(rawPath)}）`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", `（位于 ${shortenPath(rawPath)}）`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface CachedMessage {
	source: AgentMessage;
	signature: string;
	component?: Component;
}

function messageSignature(message: AgentMessage, record: ChildSessionRecord): string {
	if (message.role === "assistant") {
		return message.content.map((part) => {
			if (part.type === "text") return `text:${part.text.length}`;
			if (part.type === "thinking") return `thinking:${part.thinking.length}`;
			const activity = record.transcript.tools.get(part.id);
			return `tool:${part.name}:${JSON.stringify(part.arguments).length}:${activity?.status ?? "pending"}`;
		}).join("|");
	}
	if (message.role === "user") {
		return typeof message.content === "string"
			? `user:${message.content.length}`
			: message.content.map((part) => part.type === "text" ? `text:${part.text.length}` : "image").join("|");
	}
	if (message.role === "toolResult") {
		return `${message.isError}:${message.content.map((part) => part.type === "text" ? part.text.length : 0).join(",")}`;
	}
	return message.role;
}

function textParts(content: readonly (TextContent | ImageContent)[]): string {
	return content.map((part) => part.type === "text" ? String(part.text ?? "") : "[图片]").join("\n");
}

function renderMessage(
	message: AgentMessage,
	record: ChildSessionRecord,
	theme: Theme,
): Component | undefined {
	const container = new Container();
	if (message.role === "user") {
		const text = typeof message.content === "string" ? message.content : textParts(message.content);
		container.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
		return container;
	}
	if (message.role === "assistant") {
		for (const part of message.content) {
			if (part.type === "thinking") container.addChild(new Text(theme.fg("muted", part.thinking), 0, 0));
			else if (part.type === "text") container.addChild(new Markdown(part.text, 0, 0, getMarkdownTheme()));
			else {
				const activity = record.transcript.tools.get(part.id);
				const status = activity ? ` [${formatStatus(activity.status)}]` : "";
				container.addChild(new Text(`${formatToolCall(part.name, part.arguments, theme.fg.bind(theme))}${status}`, 0, 0));
			}
		}
		return container;
	}
	if (message.role === "toolResult") {
		const output = truncateUtf8(textParts(message.content), 50 * 1024);
		const text = `${message.toolName} ${message.isError ? "失败" : "已完成"}\n${output}`;
		container.addChild(new Text(theme.fg(message.isError ? "error" : "toolOutput", text), 0, 0));
		return container;
	}
	return undefined;
}

class MessageDocument extends Container {
	private readonly record: ChildSessionRecord;
	private readonly theme: Theme;
	private cache: CachedMessage[] = [];

	constructor(record: ChildSessionRecord, theme: Theme) {
		super();
		this.record = record;
		this.theme = theme;
		this.sync();
	}

	sync(): void {
		const next = this.record.transcript.messages.map((source, index) => {
			const revision = this.record.transcript.revisions[index] ?? 0;
			const signature = `${revision}:${messageSignature(source, this.record)}`;
			const previous = this.cache[index];
			if (previous?.source === source && previous.signature === signature) return previous;
			return { source, signature, component: renderMessage(source, this.record, this.theme) };
		});
		this.cache = next;
		this.children = next.flatMap((entry) => entry.component ? [entry.component] : []);
	}
}

export class SubagentViewer extends Container {
	readonly capturesViewportInput = true;
	private readonly record: ChildSessionRecord;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly document: MessageDocument;
	private readonly transcript: ScrollView;
	private readonly content: Container;
	private readonly header: Text;
	private readonly root: VStack;
	private readonly unsubscribe: () => void;
	private lastFrame: LayoutFrame | undefined;

	constructor(
		record: ChildSessionRecord,
		store: ChildSessionStore,
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: () => void,
	) {
		super();
		this.record = record;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.header = new Text(this.headerText(), 0, 0);
		this.document = new MessageDocument(record, theme);
		this.content = new Container();
		this.transcript = new ScrollView(this.content, {
			follow: "end",
			primary: true,
			overscroll: "contain",
			scrollbar: "auto",
		});
		const footer = new Text(theme.fg("muted", "↑/↓ 滚动 · PgUp/PgDn 翻页 · Home/End 首行/末行 · Esc 关闭"), 0, 0);
		this.root = new VStack([
			{ component: this.header, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			{ component: this.transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: footer, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		this.addChild(this.root);
		this.syncContent();
		this.unsubscribe = store.subscribe(record.runId, () => this.update());
	}

	render(width: number): string[] {
		// Host overlays call render(width) without layout; use pi's engine to give the VStack terminal height.
		const frame = renderLayoutFrame(this.root, width, this.tui.terminal.rows, () => this.tui.requestRender());
		this.lastFrame = frame;
		return frame.lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.type !== "wheel") return super.handleMouse(event);
		let remaining = event.wheelDelta ?? 0;
		if (this.lastFrame && remaining !== 0) {
			for (const scrollView of getScrollViewsAt(this.lastFrame, event.x, event.y)) {
				remaining = scrollView.scrollBy(remaining);
				if (remaining === 0 || scrollView.overscroll === "contain") break;
			}
		}
		this.tui.requestRender();
		return {
			handled: true,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) this.transcript.scrollBy(-1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.transcript.scrollBy(1);
		else if (this.keybindings.matches(data, "tui.select.pageUp")) this.transcript.scrollBy(-Math.max(1, this.transcript.viewportHeight));
		else if (this.keybindings.matches(data, "tui.select.pageDown")) this.transcript.scrollBy(Math.max(1, this.transcript.viewportHeight));
		else if (this.keybindings.matches(data, "tui.editor.cursorLineStart")) this.transcript.scrollToStart();
		else if (this.keybindings.matches(data, "tui.editor.cursorLineEnd")) this.transcript.scrollToEnd();
		else return;
		this.tui.requestRender();
	}

	dispose(): void { this.unsubscribe(); }

	private headerText(): string {
		const model = this.record.model
			? `${this.record.model}${this.record.thinking ? `:${this.record.thinking}` : ""}`
			: undefined;
		return `${this.theme.fg("toolTitle", this.theme.bold("子代理 "))}${this.theme.fg("accent", this.record.agent)}${this.theme.fg("muted", ` [${formatStatus(this.record.status)}]${model ? ` · ${model}` : ""}`)}\n${this.theme.fg("dim", this.record.description)}`;
	}

	private syncContent(): void {
		this.content.children = this.record.error
			? [new Text(this.theme.fg("error", this.record.error), 0, 0), this.document]
			: [this.document];
	}

	private update(): void {
		this.document.sync();
		this.header.setText(this.headerText());
		this.syncContent();
		this.tui.requestRender();
	}
}

export class ViewerController {
	private readonly store: ChildSessionStore;
	private activeClose: (() => void) | undefined;

	constructor(store: ChildSessionStore) { this.store = store; }

	async open(runId: string, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") return;
		const record = this.store.get(runId);
		if (!record) {
			ctx.ui.notify("子代理会话不可用", "error");
			return;
		}
		this.close();
		let close: (() => void) | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				close = () => {
					if (this.activeClose === close) this.activeClose = undefined;
					done();
				};
				this.activeClose = close;
				return new SubagentViewer(record, this.store, tui, theme, keybindings, close);
			}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
		} finally {
			if (close && this.activeClose === close) this.activeClose = undefined;
		}
	}

	close(): void { this.activeClose?.(); }
}
