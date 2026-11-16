// 终端文本工具：表格切片与高亮内容边界统一委托 pi-tui 的完整字素宽度实现。
// 与渲染器共享宽度规则，避免 CJK、emoji、组合字素和 ANSI 序列造成列偏移。

import { sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;:]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\([0-2A-B]|[#=>][0-9]?|[@-Z\\-_])/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "")
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
  return stripTerminalSequences(sliceByColumn(raw, start, length, true))
}
