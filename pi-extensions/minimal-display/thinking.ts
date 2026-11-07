/**
 * FEATURE 2: thinking blocks.
 *
 * Collapsed — one line replacing Pi's bare "Thinking..." label, installed as
 * `Bridge.thinkingPreview`:
 *
 *     • think ×1    ← while streaming
 *     ✓ think ×1    ← once the message completes
 *
 * The thinking text itself is intentionally not shown; Ctrl+T reveals Pi's full
 * Markdown. Expanded thinking keeps the single-hue theme below.
 */

import { CompactLine, realTimers, type Timers } from "./components.ts";
import { Painter, type ThemeLike } from "./row.ts";
import type { RunGrouping } from "./run-grouping.ts";
import type { Config } from "./config.ts";

/** Core calls this with the full hidden thinking text plus a streaming flag. */
export type ThinkingPreview = (
  _text: string,
  theme: ThemeLike,
  streaming?: boolean,
  owner?: object,
  runIndex?: number,
) => CompactLine;

export type ThinkingDeps = {
  config: Config;
  grouping: RunGrouping;
  timers?: Timers;
};

export function createThinkingPreview(deps: ThinkingDeps): ThinkingPreview {
  const { config, grouping } = deps;
  const timers = deps.timers ?? realTimers;

  return (_text, theme, streaming, owner, runIndex) => {
    const line = new CompactLine(timers);

    // Collapsed thinking is a count row, not a preview: no width budget and no
    // thinking text. The text argument is kept because core still passes it.
    const paint = () => {
      const glyphs = config.glyphs();
      const tokens = config.tokens();
      // Core only installs this row when thinkingAsToolCall is enabled.
      // Match tool-row styling; off keeps Pi's original thinking component.
      return new Painter(theme, config).labeled({
        glyph: streaming ? glyphs.running : glyphs.done,
        label: "think",
        labelColor: tokens.thinking,
        glyphColor: tokens.thinking,
        details: `${glyphs.count}1`,
      });
    };

    if (owner && runIndex !== undefined) {
      const id = grouping.thinkingId(owner, runIndex);
      line.setRow(() => grouping.rowFor(id, new Painter(theme, config), paint), (onHeader) => grouping.click(id, onHeader));
    } else {
      line.setRow(paint);
    }
    return line;
  };
}

type MarkdownTheme = Record<string, unknown>;

/**
 * Keep Markdown structure and styles, but replace every token-specific color
 * with the thinking hue, so expanded thinking reads as one block of reasoning
 * rather than syntax-highlighted code.
 */
export function singleHueThinkingTheme(base: MarkdownTheme, theme: ThemeLike, config: Config): MarkdownTheme {
  const hue = (text: string) => theme.fg(config.tokens().thinking, text);
  return {
    ...base,
    heading: hue,
    link: hue,
    linkUrl: hue,
    code: hue,
    codeBlock: hue,
    codeBlockBorder: hue,
    quote: hue,
    quoteBorder: hue,
    hr: hue,
    listBullet: hue,
    codeBlockIndent:
      typeof base.codeBlockIndent === "string"
        ? // Strip existing color first: the indent arrives already themed, and
          // nesting color codes leaves the outer one active for the whole line.
          hue(base.codeBlockIndent.replace(/\x1b\[[0-9;]*m/g, ""))
        : base.codeBlockIndent,
    // cli-highlight injects its own token colors, so bypass it entirely.
    highlightCode: (code: string) => code.split("\n").map(hue),
  };
}
