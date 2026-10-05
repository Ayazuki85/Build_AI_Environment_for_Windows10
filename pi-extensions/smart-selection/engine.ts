// 表格结构重建：从 pi 渲染后的扁平文本行恢复表格网格。
// pi 表格格式（components/markdown.js renderTable）：
//   ┌─{─×w}─┬─...─┐   顶边框（┬ 列位 = 列边界）
//   │ cell │ cell │   内容行（文本区 = 边界内缩 1 格 padding）
//   ├─{─×w}─┼─...─┤   分隔行（表头后 + 每个数据逻辑行之间）
//   └─{─×w}─┴─...─┘   底边框
import { slicePlainByColumn, stripAnsi } from "./term-text.ts"

export interface LogicalRowGeom {
  firstLine: number
  lastLine: number
}

export interface TableModel {
  topRow: number
  bottomRow: number
  /** 可见列边界，长度 = 列数 + 1 */
  boundaries: number[]
  /** logicalRows[0] 为表头 */
  logicalRows: LogicalRowGeom[]
}

export interface CellRef {
  table: TableModel
  rowIdx: number
  colIdx: number
}

const TOP_RE = /^(\s*)┌[─┬]+┐\s*$/
const SEP_RE = /^\s*├[─┼]+┤\s*$/
const BOT_RE = /^\s*└[─┴]+┘\s*$/

export function parseTables(lines: readonly string[]): TableModel[] {
  const tables: TableModel[] = []
  const stripped = lines.map(stripAnsi)
  let i = 0
  while (i < stripped.length) {
    const top = TOP_RE.exec(stripped[i] ?? "")
    if (!top) {
      i++
      continue
    }
    const table = tryParseTable(lines, stripped, i, top[1]!.length)
    if (table) {
      tables.push(table)
      i = table.bottomRow + 1
    } else {
      i++
    }
  }
  return tables
}

function tryParseTable(
  raw: readonly string[],
  stripped: readonly string[],
  topIdx: number,
  indent: number,
): TableModel | null {
  const topLine = stripped[topIdx]!
  // 边框行纯单宽字符：字符串下标 === 可见列
  const boundaries: number[] = [indent]
  let closed = false
  for (let c = indent + 1; c < topLine.length; c++) {
    const ch = topLine[c]
    if (ch === "┬") boundaries.push(c)
    else if (ch === "┐") {
      boundaries.push(c)
      closed = true
      break
    }
  }
  if (!closed || boundaries.length < 2) return null

  const logicalRows: LogicalRowGeom[] = []
  let blockStart = -1
  for (let row = topIdx + 1; row < stripped.length; row++) {
    const line = stripped[row]!
    if (SEP_RE.test(line)) {
      if (blockStart < 0) return null // 分隔线前必须有内容块
      logicalRows.push({ firstLine: blockStart, lastLine: row - 1 })
      blockStart = -1
      continue
    }
    if (BOT_RE.test(line)) {
      if (blockStart >= 0) logicalRows.push({ firstLine: blockStart, lastLine: row - 1 })
      if (logicalRows.length === 0) return null
      return { topRow: topIdx, bottomRow: row, boundaries, logicalRows }
    }
    // 内容行：所有边界列必须是 │（用原始行按可见列校验，CJK 安全）
    if (boundaries.every((b) => slicePlainByColumn(raw[row]!, b, 1) === "│")) {
      if (blockStart < 0) blockStart = row
      continue
    }
    return null // 其他行 → 非表格
  }
  return null // 未闭合
}

/** 单元格文本区（半开 [left, right)）：边界内缩 1 格 padding。 */
export function cellTextArea(table: TableModel, colIdx: number): readonly [number, number] {
  return [table.boundaries[colIdx]! + 2, table.boundaries[colIdx + 1]! - 1]
}

/**
 * 定位 (row, col) 所属单元格。
 * 命中边框行/分隔行/边框列/表外 → null（对齐 OpenTUI shouldStartSelection）。
 * padding 区（边界 ±1 的空格列）算作单元格内。
 */
export function locateCell(tables: readonly TableModel[], row: number, col: number): CellRef | null {
  for (const table of tables) {
    if (row <= table.topRow || row >= table.bottomRow) continue
    const b = table.boundaries
    let colIdx = -1
    for (let i = 0; i + 1 < b.length; i++) {
      if (col === b[i]) break // 命中边框列
      if (col > b[i]! && col < b[i + 1]!) {
        colIdx = i
        break
      }
    }
    if (colIdx < 0) continue
    const rowIdx = table.logicalRows.findIndex((r) => row >= r.firstLine && row <= r.lastLine)
    if (rowIdx < 0) return null // 分隔行
    return { table, rowIdx, colIdx }
  }
  return null
}
