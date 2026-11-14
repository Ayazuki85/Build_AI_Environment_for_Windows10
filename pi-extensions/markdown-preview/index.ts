import {
  copyToClipboard,
  UserMessageComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { hyperlink, Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { registerCjkMarkdownTransformer } from "./cjk-markdown.js";
import { CodeCopyController } from "./code-copy.js";
import {
  installSharedPatch,
  type SharedPatchState,
  uninstallSharedPatch,
} from "./patch-lifecycle.js";

const MARKDOWN_PATCH_STATE = Symbol.for("pi-agent-beautify.markdown.patch");
const USER_MESSAGE_PATCH_STATE = Symbol.for("pi-agent-beautify.user-message.patch");
const MARKDOWN_LIST_PATCH_STATE = Symbol.for("pi-agent-beautify.markdown-list.patch.v2");
const MARKDOWN_RENDER_PATCH_STATE = Symbol.for("pi-agent-beautify.markdown-render.patch.v2");
const PLAIN_CODE_LANGS = new Set(["text", "plain", "plaintext"]);
/** Left accent bar for user messages (1 terminal column). */
const USER_MESSAGE_BAR = "▎";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
/** Same keys pi uses so theme stays valid across /new /reload /session switch. */
const PI_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const PI_THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

/**
 * Read the live Theme from globalThis — never close over extension ctx.
 * Session replacement invalidates ctx.ui, but the active Theme is always here.
 */
function getActiveTheme(): Theme | undefined {
  const g = globalThis as typeof globalThis & Record<symbol, Theme | undefined>;
  return g[PI_THEME_KEY] ?? g[PI_THEME_KEY_OLD];
}

function paintUserMessageBar(text: string): string {
  const active = getActiveTheme();
  if (!active) return text;
  try {
    return active.fg("borderAccent", text);
  } catch {
    try {
      return active.fg("border", text);
    } catch {
      return text;
    }
  }
}

function paintToolPanelBg(text: string): string {
  const active = getActiveTheme();
  if (!active) return text;
  try {
    return active.bg("toolPendingBg", text);
  } catch {
    return text;
  }
}
interface MarkdownCodeToken {
  type: "code";
  lang?: string;
  text?: string;
}

interface MarkdownHeadingToken {
  type: "heading";
  depth: number;
  tokens?: unknown[];
}

interface MarkdownListToken {
  type: "list";
  ordered?: boolean;
}

interface BeautifyMarkdownTheme {
  heading: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  hr: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  codeBlockIndent?: string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface InlineStyleContext {
  applyText: (text: string) => string;
  stylePrefix: string;
}

interface MarkdownRuntime {
  theme: BeautifyMarkdownTheme;
  invalidate?: () => void;
  applyDefaultStyle?: (text: string) => string;
  getStylePrefix?: (styleFn: (text: string) => string) => string;
  renderInlineTokens?: (tokens: unknown[], styleContext?: InlineStyleContext) => string;
}

type MarkdownRenderToken = (this: MarkdownRuntime, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
type MarkdownRenderList = (this: MarkdownRuntime, token: MarkdownListToken, depth: number, width: number, styleContext?: unknown) => string[];

interface MarkdownTokenPatchState extends SharedPatchState<MarkdownRenderToken> {
  codeBlockBg?: (text: string) => string;
  renderCodeToken: (
    instance: MarkdownRuntime,
    token: MarkdownCodeToken,
    width: number,
    nextTokenType?: string,
  ) => string[];
  renderHeadingToken: (
    instance: MarkdownRuntime,
    token: MarkdownHeadingToken,
    width: number,
    nextTokenType?: string,
  ) => string[];
}

interface MarkdownListPatchState extends SharedPatchState<MarkdownRenderList> {
  renderList: (
    instance: MarkdownRuntime,
    token: MarkdownListToken,
    depth: number,
    width: number,
    styleContext?: unknown,
  ) => string[];
}

type MarkdownRender = (this: MarkdownRuntime, width: number) => string[];

interface MarkdownRenderPatchState extends SharedPatchState<MarkdownRender> {
  codeCopy: CodeCopyController;
  versions: WeakMap<object, number>;
  instances: Set<WeakRef<MarkdownRuntime>>;
}

type PatchedMarkdownPrototype = {
  render?: MarkdownRender;
  renderToken?: MarkdownRenderToken;
  renderList?: MarkdownRenderList;
  [key: symbol]: unknown;
};

function isMarkdownCodeToken(token: unknown): token is MarkdownCodeToken {
  return typeof token === "object" && token !== null && (token as { type?: unknown }).type === "code";
}

function isMarkdownHeadingToken(token: unknown): token is MarkdownHeadingToken {
  return typeof token === "object" && token !== null && (token as { type?: unknown }).type === "heading";
}

/** Restore a code panel's background after SGR resets, including compound SGR. */
function restoreCodeBackground(text: string, backgroundPrefix: string): string {
  return text.replace(/\x1b\[([0-9;]*)m/g, (sequence, rawParams: string) => {
    const params = rawParams === "" ? [0] : rawParams.split(";").map(Number);
    let restore = false;

    for (let index = 0; index < params.length; index++) {
      const code = params[index];
      if (code === 0 || code === 49) {
        restore = true;
        continue;
      }
      if (code === 38 || code === 48 || code === 58) {
        if (code === 48) restore = false;
        // Skip color arguments so a palette index such as 49 is not mistaken
        // for the independent background-reset command.
        if (params[index + 1] === 5) index += 2;
        else if (params[index + 1] === 2) index += 4;
        continue;
      }
      if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) restore = false;
    }

    return restore ? sequence + backgroundPrefix : sequence;
  });
}

/**
 * Paint a code line with the same kind of solid background used by tool-execution panels.
 * Pads to `width` so the bar reads as a block; no border glyphs (copy stays clean).
 */
function paintCodeLine(text: string, width: number, bgFn?: (text: string) => string): string {
  if (!bgFn) return text;
  const pad = Math.max(0, width - visibleWidth(text));

  // Theme.bg() sets the background once and closes it with SGR 49. Syntax
  // highlighters can emit SGR 0/49 inside the line, which would otherwise leave
  // the remaining text and right padding on the terminal's default background.
  const sentinel = "\0";
  const sample = bgFn(sentinel);
  const sentinelIndex = sample.indexOf(sentinel);
  const backgroundPrefix = sentinelIndex >= 0 ? sample.slice(0, sentinelIndex) : "";
  const content = backgroundPrefix ? restoreCodeBackground(text, backgroundPrefix) : text;
  return bgFn(content + " ".repeat(pad));
}

function renderCodeTokenWithoutFences(
  instance: MarkdownRuntime,
  token: MarkdownCodeToken,
  width: number,
  nextTokenType: string | undefined,
  codeCopy: CodeCopyController,
  backgroundPainter?: (text: string) => string,
): string[] {
  const raw = typeof token.text === "string" ? token.text : "";
  const langRaw = typeof token.lang === "string" ? token.lang.trim() : "";
  const lang = langRaw.toLowerCase();
  const lines: string[] = [];
  const indent = instance.theme.codeBlockIndent ?? "  ";
  const bgFn = backgroundPainter;
  const w = Math.max(1, width);
  const fittedIndent = w - visibleWidth(indent) >= 2 ? indent : "";
  const textWidth = w - visibleWidth(fittedIndent);

  // text/plain fences: still no syntax-highlight chrome, but use the same panel
  // background — these blocks are often used for emphasis / expected output.
  let contentLines: string[];
  if (PLAIN_CODE_LANGS.has(lang)) {
    contentLines = raw.split("\n").map((line) => instance.applyDefaultStyle?.(line) ?? line);
  } else if (instance.theme.highlightCode) {
    contentLines = instance.theme.highlightCode(raw, token.lang);
  } else {
    contentLines = raw.split("\n").map((line) => instance.theme.codeBlock(line));
  }

  // No raw ``` fences, no box-drawing glyphs.
  // Tool-panel background + light indent keeps blocks distinct and copy-safe.
  let header = "";
  try {
    header = codeCopy.renderHeader({ lang: langRaw, code: raw }, w, instance.theme.codeBlockBorder);
  } catch {
    // Copy-button helpers are optional chrome: preserve the existing blank top row and body.
  }
  lines.push(paintCodeLine(header, w, bgFn));
  if (contentLines.length === 0) {
    lines.push(paintCodeLine(fittedIndent, w, bgFn));
  } else {
    // Wrap before painting: Markdown's outer renderer will not wrap these full-width
    // rows again, so every physical row gets its own background and right padding.
    for (const line of contentLines) {
      for (const wrappedLine of wrapTextWithAnsi(line, textWidth)) {
        lines.push(paintCodeLine(`${fittedIndent}${wrappedLine}`, w, bgFn));
      }
    }
  }
  lines.push(paintCodeLine("", w, bgFn));

  if (nextTokenType && nextTokenType !== "space") lines.push("");
  return lines;
}

/**
 * Build a level-aware style for natural heading rendering (no raw "#" markers).
 * Hierarchy is expressed with weight / underline / italic / indent / rule lines.
 */
function createHeadingStyleFn(theme: BeautifyMarkdownTheme, level: number): (text: string) => string {
  switch (level) {
    case 1:
      // Strongest: bold (underline comes from the dedicated rule line)
      return (text) => theme.heading(theme.bold(text));
    case 2:
      // Major section: bold
      return (text) => theme.heading(theme.bold(text));
    case 3:
      // Subsection: heading color only (no bold)
      return (text) => theme.heading(text);
    case 4:
      // Nested: italic heading color
      return (text) => theme.heading(theme.italic(text));
    case 5:
      // Deep: dimmer via hr palette + italic
      return (text) => theme.hr(theme.italic(text));
    default:
      // Deepest: quietest
      return (text) => theme.hr(theme.italic(text));
  }
}

/** Left indent grows with depth so nested sections are easy to scan. */
function headingIndent(level: number): string {
  // Keep H1/H2 flush-left; start indenting from H3 so top titles dominate.
  if (level <= 2) return "";
  return "  ".repeat(level - 2);
}

/**
 * Optional level marker that is NOT the raw markdown "#".
 * Keeps hierarchy readable without looking like unrendered source.
 */
function headingMarker(theme: BeautifyMarkdownTheme, level: number): string {
  switch (level) {
    case 1:
      // Filled diamond: strongest visual weight for the top-level title.
      return theme.heading(theme.bold("◆ "));
    case 2:
      // Hollow diamond: same family as H1, but visually lighter.
      return theme.heading(theme.bold("◇ "));
    case 3:
      return theme.heading("▸ ");
    case 4:
      return theme.hr("▹ ");
    case 5:
    default:
      // Deep headings share a quiet middle dot; indentation carries the hierarchy.
      return theme.hr("· ");
  }
}

/** Visible width without ANSI escape sequences. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Decorative underline under H1 / H2.
 * Uses heading color (not dim hr) so the rule actually stands out on dark themes.
 */
function headingRule(
  theme: BeautifyMarkdownTheme,
  level: number,
  width: number,
  titleVisibleWidth: number,
): string | undefined {
  if (level !== 1 && level !== 2) return undefined;
  // Fit the rule to the title when possible; fall back to a readable fixed span.
  const preferred = level === 1 ? Math.max(titleVisibleWidth, 12) : Math.max(titleVisibleWidth, 10);
  const ruleWidth = Math.max(8, Math.min(width, preferred));
  const ch = level === 1 ? "═" : "─";
  // heading color keeps the rule on the same palette as the title
  return theme.heading(ch.repeat(ruleWidth));
}

/**
 * Render headings as styled text without raw markdown markers.
 * Upstream pi-tui already hides "#" / "##" for h1/h2, but still prints
 * "###"… markers for h3+. This normalizes every level to natural heading style
 * and adds a clear visual hierarchy across H1–H6.
 */
function renderHeadingTokenNatural(
  instance: MarkdownRuntime,
  token: MarkdownHeadingToken,
  width: number,
  nextTokenType?: string,
): string[] {
  const headingLevel = Math.max(1, Math.min(6, Number(token.depth) || 1));
  const headingStyleFn = createHeadingStyleFn(instance.theme, headingLevel);
  const indent = headingIndent(headingLevel);

  const headingStyleContext: InlineStyleContext = {
    applyText: headingStyleFn,
    stylePrefix: instance.getStylePrefix?.(headingStyleFn) ?? "",
  };

  // No raw "#" markers — use styled hierarchy (indent / weight / glyph / rule).
  const headingText = instance.renderInlineTokens?.(token.tokens || [], headingStyleContext) ?? "";
  const marker = headingMarker(instance.theme, headingLevel);
  const titleLine = `${indent}${marker}${headingText}`;
  const lines: string[] = [titleLine];

  const titleVisibleWidth = stripAnsi(`${marker}${headingText}`).length;
  const rule = headingRule(
    instance.theme,
    headingLevel,
    Math.max(1, width - indent.length),
    titleVisibleWidth,
  );
  if (rule) lines.push(`${indent}${rule}`);

  // Extra breathing room after top-level headings
  if (headingLevel <= 2) {
    if (nextTokenType && nextTokenType !== "space") lines.push("");
  } else if (nextTokenType && nextTokenType !== "space") {
    lines.push("");
  }
  return lines;
}

const UNORDERED_LIST_BULLETS = ["•", "◦", "▪"] as const;
const ANSI_SGR_AT_START_RE = /^\u001b\[[0-9;]*m/;

function unorderedListBullet(depth: number): string {
  const normalizedDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return UNORDERED_LIST_BULLETS[Math.min(normalizedDepth, UNORDERED_LIST_BULLETS.length - 1)];
}

/** Replace only the marker at Pi's list-prefix column, preserving ANSI styling and layout. */
function replaceListMarkerAtVisibleColumn(line: string, column: number, bullet: string): string {
  let visibleColumn = 0;
  for (let index = 0; index < line.length;) {
    if (line.charCodeAt(index) === 0x1b) {
      const ansi = ANSI_SGR_AT_START_RE.exec(line.slice(index));
      if (ansi) {
        index += ansi[0].length;
        continue;
      }
    }

    if (visibleColumn === column) {
      const marker = line[index];
      const following = line[index + 1];
      if ((marker !== "-" && marker !== "+" && marker !== "*") || (following !== " " && following !== "\t")) return line;
      return line.slice(0, index) + bullet + line.slice(index + 1);
    }

    index++;
    visibleColumn++;
  }
  return line;
}

function renderListWithNaturalBullets(
  instance: MarkdownRuntime,
  token: MarkdownListToken,
  depth: number,
  width: number,
  styleContext?: unknown,
): string[] {
  const proto = Markdown.prototype as unknown as PatchedMarkdownPrototype;
  const original = (proto[MARKDOWN_LIST_PATCH_STATE] as MarkdownListPatchState | undefined)?.original;
  if (!original) return [];

  // Pi retains ownership of parsing, nesting, task markers, wrapping, and spacing.
  const lines = original.call(instance, token, depth, width, styleContext);
  if (token.ordered) return lines;

  // Pi's renderer prefixes each nesting level with four spaces. Replacing the
  // one-column marker leaves all continuation lines and terminal widths intact.
  const normalizedDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  const markerColumn = normalizedDepth * 4;
  const bullet = unorderedListBullet(normalizedDepth);
  return lines.map((line) => replaceListMarkerAtVisibleColumn(line, markerColumn, bullet));
}

function migrateLegacyMarkdownPatches(proto: PatchedMarkdownPrototype): void {
  const legacy = proto[MARKDOWN_PATCH_STATE] as {
    installed?: boolean;
    wrapper?: unknown;
    original?: MarkdownRenderToken;
    originalRenderList?: MarkdownRenderList;
  } | undefined;
  if (!legacy?.installed || typeof legacy.wrapper === "function") return;
  // The pre-lifecycle version had no active flag or stored wrapper. Restore its originals once so
  // its old wrappers cannot remain above the new active-aware shared wrappers after the first reload.
  if (typeof legacy.original === "function") proto.renderToken = legacy.original;
  if (typeof legacy.originalRenderList === "function") proto.renderList = legacy.originalRenderList;
  delete proto[MARKDOWN_PATCH_STATE];
}

function installMarkdownListPatch(proto: PatchedMarkdownPrototype): void {
  const state = installSharedPatch<MarkdownRenderList>(
    proto as Record<PropertyKey, unknown>,
    "renderList",
    MARKDOWN_LIST_PATCH_STATE,
    (original, patch) =>
      function (this: MarkdownRuntime, token: MarkdownListToken, depth: number, width: number, styleContext?: unknown): string[] {
        const current = patch as MarkdownListPatchState;
        if (!patch.active) return original.call(this, token, depth, width, styleContext);
        return current.renderList(this, token, depth, width, styleContext);
      },
  ) as MarkdownListPatchState;
  state.renderList = renderListWithNaturalBullets;
}

function installMarkdownRenderPatch(
  proto: PatchedMarkdownPrototype,
  codeCopy: CodeCopyController,
): void {
  const state = installSharedPatch<MarkdownRender>(
    proto as Record<PropertyKey, unknown>,
    "render",
    MARKDOWN_RENDER_PATCH_STATE,
    (original, patch) =>
      function (this: MarkdownRuntime, width: number): string[] {
        if (!patch.active) return original.call(this, width);
        const current = patch as MarkdownRenderPatchState;
        // Pi keeps one stable proxy while switchTuiMode() replaces its concrete renderer.
        // Reconcile before the cache-version check so a mode change invalidates cached headers.
        current.codeCopy.reconcileLinkTarget();
        const version = current.codeCopy.renderVersion;
        const previous = current.versions.get(this);
        if (previous === undefined) current.instances.add(new WeakRef(this));
        // An untracked instance may have cached stock output while the extension was removed.
        if (previous !== version) this.invalidate?.();
        current.versions.set(this, version);
        return original.call(this, width);
      },
  ) as MarkdownRenderPatchState;
  state.codeCopy = codeCopy;
  state.versions ??= new WeakMap<object, number>();
  state.instances ??= new Set<WeakRef<MarkdownRuntime>>();
}

function installMarkdownBeautifyPatch(codeCopy: CodeCopyController): void {
  const proto = Markdown.prototype as unknown as PatchedMarkdownPrototype;
  migrateLegacyMarkdownPatches(proto);
  const state = installSharedPatch<MarkdownRenderToken>(
    proto as Record<PropertyKey, unknown>,
    "renderToken",
    MARKDOWN_PATCH_STATE,
    (original, patch) =>
      function (this: MarkdownRuntime, token: unknown, width: number, nextTokenType?: string, styleContext?: unknown): string[] {
        const current = patch as MarkdownTokenPatchState;
        if (!patch.active) return original.call(this, token, width, nextTokenType, styleContext);
        if (isMarkdownHeadingToken(token)) return current.renderHeadingToken(this, token, width, nextTokenType);
        if (isMarkdownCodeToken(token)) return current.renderCodeToken(this, token, width, nextTokenType);
        return original.call(this, token, width, nextTokenType, styleContext);
      },
  ) as MarkdownTokenPatchState;
  state.codeBlockBg = paintToolPanelBg;
  state.renderHeadingToken = renderHeadingTokenNatural;
  state.renderCodeToken = (instance, token, width, nextTokenType) =>
    renderCodeTokenWithoutFences(instance, token, width, nextTokenType, codeCopy, state.codeBlockBg);
  installMarkdownListPatch(proto);
  installMarkdownRenderPatch(proto, codeCopy);
}

function uninstallMarkdownBeautifyPatch(): void {
  const proto = Markdown.prototype as unknown as PatchedMarkdownPrototype;
  const renderState = proto[MARKDOWN_RENDER_PATCH_STATE] as MarkdownRenderPatchState | undefined;
  for (const reference of renderState?.instances ?? []) {
    const instance = reference.deref();
    if (!instance) continue;
    instance.invalidate?.();
    // A later activation starts again at version 1. Delete the old record so the
    // next render tracks this instance and the following shutdown can invalidate it.
    renderState?.versions.delete(instance);
  }
  renderState?.instances.clear();
  uninstallSharedPatch(proto as Record<PropertyKey, unknown>, "renderToken", MARKDOWN_PATCH_STATE);
  uninstallSharedPatch(proto as Record<PropertyKey, unknown>, "renderList", MARKDOWN_LIST_PATCH_STATE);
  uninstallSharedPatch(proto as Record<PropertyKey, unknown>, "render", MARKDOWN_RENDER_PATCH_STATE);
}

type UserMessageRender = (this: unknown, width: number) => string[];

type UserMessagePatchState = SharedPatchState<UserMessageRender>;

type PatchedUserMessagePrototype = {
  render?: UserMessageRender;
  [key: symbol]: unknown;
};

/**
 * Strip OSC 133 shell-integration markers so we can re-wrap lines cleanly.
 * UserMessageComponent injects these around the first/last rendered lines.
 */
function stripOsc133(line: string): string {
  return line
    .replaceAll(OSC133_ZONE_START, "")
    .replaceAll(OSC133_ZONE_END, "")
    .replaceAll(OSC133_ZONE_FINAL, "");
}

/**
 * Paint a light-blue left bar on every user-message line.
 * Mirrors the accent stripe in modern chat UIs (screenshot style).
 *
 * Caller should render the original component at `width - barWidth` so layout
 * already accounts for the column we prepend — no right-edge clipping.
 */
function withUserMessageBar(lines: string[]): string[] {
  if (lines.length === 0) return lines;

  // Resolve bar color from the live global theme on every paint — never from a
  // captured extension ctx (those go stale after /new, /reload, session switch).
  const bar = paintUserMessageBar(USER_MESSAGE_BAR);

  const painted = lines.map((raw) => {
    // Strip OSC markers first; re-wrap after prepending the bar.
    const body = stripOsc133(raw);
    return `${bar}${body}`;
  });

  // Re-apply OSC 133 markers so shell integration / terminal zones stay intact.
  painted[0] = OSC133_ZONE_START + painted[0];
  painted[painted.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + painted[painted.length - 1];
  return painted;
}

function migrateLegacyUserMessagePatch(proto: PatchedUserMessagePrototype): void {
  const legacy = proto[USER_MESSAGE_PATCH_STATE] as {
    installed?: boolean;
    wrapper?: unknown;
    original?: UserMessageRender;
  } | undefined;
  if (!legacy?.installed || typeof legacy.wrapper === "function") return;
  if (typeof legacy.original === "function") proto.render = legacy.original;
  delete proto[USER_MESSAGE_PATCH_STATE];
}

function installUserMessageBarPatch(): void {
  const proto = UserMessageComponent.prototype as unknown as PatchedUserMessagePrototype;
  migrateLegacyUserMessagePatch(proto);
  installSharedPatch<UserMessageRender>(
    proto as Record<PropertyKey, unknown>,
    "render",
    USER_MESSAGE_PATCH_STATE,
    (original, patch) =>
      function (this: unknown, width: number): string[] {
        if (!patch.active) return original.call(this, width);
        const barWidth = visibleWidth(USER_MESSAGE_BAR);
        const contentWidth = Math.max(1, width - barWidth);
        return withUserMessageBar(original.call(this, contentWidth));
      },
  );
}

function uninstallUserMessageBarPatch(): void {
  const proto = UserMessageComponent.prototype as unknown as PatchedUserMessagePrototype;
  uninstallSharedPatch(proto as Record<PropertyKey, unknown>, "render", USER_MESSAGE_PATCH_STATE);
}

export default function piAgentBeautify(pi: ExtensionAPI) {
  const codeCopy = new CodeCopyController({
    piCopy: copyToClipboard,
    measure: visibleWidth,
    link: hyperlink,
  });
  installMarkdownBeautifyPatch(codeCopy);
  installUserMessageBarPatch();
  registerCjkMarkdownTransformer(pi);

  pi.on("session_start", (_event, ctx) => {
    codeCopy.activate(ctx);
  });
  pi.on("session_shutdown", () => {
    codeCopy.deactivate();
    uninstallMarkdownBeautifyPatch();
    uninstallUserMessageBarPatch();
  });
}
