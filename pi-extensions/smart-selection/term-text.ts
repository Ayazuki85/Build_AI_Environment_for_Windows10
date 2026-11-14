// 终端文本工具：表格切片使用本地宽度表；高亮内容边界委托 pi-tui 的完整字素宽度实现。
// 本地宽度表覆盖常用 CJK/emoji 区间与常见零宽码点，非完整 UAX#11。

import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;:]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([0-2A-B]|[#=>][0-9]?|[@-Z\\-_])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
}

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x26a1, 0x26a1], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe1f],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

const ZERO: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
]

function inRanges(ranges: ReadonlyArray<readonly [number, number]>, cp: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = ranges[mid]!
    if (cp < a) hi = mid - 1
    else if (cp > b) lo = mid + 1
    else return true
  }
  return false
}

function codePointWidth(cp: number): number {
  if (cp === 0x200d) return 0 // ZWJ
  if (inRanges(ZERO, cp)) return 0
  if (inRanges(WIDE, cp)) return 2
  return 1
}

export function widthOf(text: string): number {
  let w = 0
  for (const ch of text) w += codePointWidth(ch.codePointAt(0)!)
  return w
}

export function contentWidthWithoutTrailingWhitespace(raw: string): number {
  return visibleWidth(stripTerminalSequences(raw).trimEnd())
}

const USER_MESSAGE_BAR = "▎"

interface LeadingPadding {
  chromeWidth: number
  whitespaceWidth: number
  blank: boolean
}

function leadingPadding(raw: string): LeadingPadding {
  const plain = stripTerminalSequences(raw)
  const chromeWidth = plain.startsWith(USER_MESSAGE_BAR) ? visibleWidth(USER_MESSAGE_BAR) : 0
  const body = chromeWidth ? plain.slice(USER_MESSAGE_BAR.length) : plain
  const whitespace = /^[ \t]*/.exec(body)?.[0] ?? ""
  return { chromeWidth, whitespaceWidth: visibleWidth(whitespace), blank: body.trim().length === 0 }
}

/** Content start after UI chrome and the selection's common renderer padding. */
export function contentStartColumn(raw: string, commonWhitespace: number): number {
  const padding = leadingPadding(raw)
  return padding.chromeWidth + Math.min(commonWhitespace, padding.whitespaceWidth)
}

const leadingCache = new WeakMap<readonly string[], { startRow: number; endRow: number; value: number }>()

/** Minimum leading whitespace across nonblank selected rows; extra indentation remains content. */
export function commonLeadingWhitespace(lines: readonly string[], startRow: number, endRow: number): number {
  const cached = leadingCache.get(lines)
  if (cached && cached.startRow === startRow && cached.endRow === endRow) return cached.value
  let common = Number.MAX_SAFE_INTEGER
  const from = Math.max(0, Math.min(startRow, endRow))
  const to = Math.min(lines.length - 1, Math.max(startRow, endRow))
  for (let row = from; row <= to; row++) {
    const padding = leadingPadding(lines[row] ?? "")
    if (padding.blank) continue
    common = Math.min(common, padding.whitespaceWidth)
  }
  const value = common === Number.MAX_SAFE_INTEGER ? 0 : common
  leadingCache.set(lines, { startRow, endRow, value })
  return value
}

export function slicePlainByColumn(raw: string, start: number, length: number): string {
  if (length <= 0) return ""
  const end = start + length
  let col = 0
  let out = ""
  let i = 0
  while (i < raw.length && col < end) {
    if (raw[i] === "\x1b") {
      const m = /\x1b(?:\[[0-9;:]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([0-2A-B]|[#=>][0-9]?|[@-Z\\-_])/.exec(raw.slice(i))
      if (m) { i += m[0].length; continue }
    }
    const cp = raw.codePointAt(i)!
    const w = codePointWidth(cp)
    const ch = String.fromCodePoint(cp)
    if (col >= start && col + w <= end) out += ch
    col += w
    i += ch.length
  }
  return out
}
