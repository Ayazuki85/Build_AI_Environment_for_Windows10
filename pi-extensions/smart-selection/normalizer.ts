// Adapted from pi-copy-soft-wrap 0.1.2 (MIT).
// https://github.com/hburaktasyurek/pi-copy-soft-wrap
import { sliceByColumn } from "@earendil-works/pi-tui"
import { contentStartColumn } from "./term-text.ts"
const STRUCTURAL_LINE = /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|)/
const BOX_TABLE_LINE = /^\s*[┌┬┐├┼┤└┴┘│]/
const INDENTED_CODE = /^\s{4,}\S/
const CODE_LINE = /^\s*(?:import|export|const|let|var|function|class|interface|type|if|else|for|while|switch|case|return|throw|try|catch)\b|[{};]\s*$/
const CJK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u

function preserveBreak(left: string, right: string): boolean {
  if (!left.trim() || !right.trim()) return true
  return STRUCTURAL_LINE.test(left) || STRUCTURAL_LINE.test(right) ||
    BOX_TABLE_LINE.test(left) || BOX_TABLE_LINE.test(right) ||
    INDENTED_CODE.test(right) || CODE_LINE.test(left) || CODE_LINE.test(right)
}

function hasUrlSentencePeriod(tail: string, head: string): boolean {
  if (!/^(?:https?:\/\/|www\.)/.test(tail) || !tail.endsWith(".") || !/^[A-Za-z]/.test(head)) return false
  const withoutPrefix = tail.replace(/^(?:https?:\/\/|www\.)/, "")
  const authority = withoutPrefix.split(/[/?#]/, 1)[0] ?? ""
  const isIncompleteBareHost = authority === withoutPrefix && /^[A-Za-z0-9-]+\.$/.test(authority)
  return !isIncompleteBareHost
}

function wrappedJoiner(left: string, right: string): string {
  const trimmedLeft = left.trimEnd()
  const tail = trimmedLeft.match(/\S+$/)?.[0] ?? ""
  const head = right.trimStart()
  if (hasUrlSentencePeriod(tail, head)) return " "
  if (/^(?:https?:\/\/|www\.|[A-Za-z]:[\\/]|\\\\)/.test(tail)) return ""
  if (/[/._?&=#%+-\\]$/.test(tail) && /^[\w/._?&=#%+-\\]/.test(head) &&
      (/[\\/]/.test(tail) || !tail.endsWith("."))) return ""

  const leftChar = [...trimmedLeft].at(-1) ?? ""
  const rightChar = [...head][0] ?? ""
  return CJK.test(leftChar) || CJK.test(rightChar) ? "" : " "
}

interface Fence {
  marker: "`" | "~"
  length: number
}

function openingFence(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  const run = match?.[1]
  if (!run || (run[0] === "`" && (match[2] ?? "").includes("`"))) return undefined
  return { marker: run[0] as Fence["marker"], length: run.length }
}

function isClosingFence(line: string, fence: Fence): boolean {
  const run = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1]
  return run?.[0] === fence.marker && run.length >= fence.length
}

function isPreformattedSelection(lines: readonly string[], leadingWhitespace: number): boolean {
  if (leadingWhitespace <= 1) return false
  let commaTerminated = 0
  for (const line of lines) {
    if (CODE_LINE.test(line) || /^\s*[}\])]/.test(line) || /^\s*[$A-Za-z_][\w$]*\s*=/.test(line)) return true
    if (/,\s*$/.test(line)) commaTerminated++
  }
  return commaTerminated >= 2
}

export interface UnwrapVisualLinesOptions {
  firstLineIncludesGutter?: boolean
  leadingWhitespace?: number
  firstLineStartColumn?: number
  /** Native selection columns already clip leading padding; disable a second clipping pass. */
  clipLeadingPadding?: boolean
}

/** Join likely visual wraps while preserving structural boundaries and removing render padding. */
export function unwrapVisualLines(
  text: string,
  options: boolean | UnwrapVisualLinesOptions = false,
): string {
  const opts = typeof options === "boolean" ? { firstLineIncludesGutter: options } : options
  const leadingWhitespace = opts.leadingWhitespace ?? 1
  const lines = text.split("\n").map((line) => line.trimEnd())
  const firstStart = opts.firstLineStartColumn ?? (opts.firstLineIncludesGutter ? 0 : undefined)
  if (opts.clipLeadingPadding ?? true) {
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? ""
      const contentStart = contentStartColumn(line, leadingWhitespace)
      const remove = index === 0
        ? firstStart === undefined ? 0 : Math.max(0, contentStart - firstStart)
        : contentStart
      lines[index] = sliceByColumn(line, remove, Number.MAX_SAFE_INTEGER, true)
    }
  }
  let result = lines[0] ?? ""
  const preformatted = isPreformattedSelection(lines, leadingWhitespace)
  let fence = openingFence(lines[0] ?? "")
  for (let index = 1; index < lines.length; index++) {
    const left = lines[index - 1] ?? ""
    const right = lines[index] ?? ""
    // With fences hidden by a renderer, extra common padding plus code syntax identifies a
    // preformatted selection without misclassifying merely indented prose as code.
    result += fence || preformatted || preserveBreak(left, right)
      ? `\n${right}`
      : `${wrappedJoiner(left, right)}${right.trimStart()}`
    if (fence) {
      if (isClosingFence(right, fence)) fence = undefined
    } else {
      fence = openingFence(right)
    }
  }
  return result
}
