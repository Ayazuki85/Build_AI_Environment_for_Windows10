// 补丁实现：五个 impl 方法 + 共享状态机。
// 约定：impl(tui, orig, ...args)；状态存 tui.__smartSelDrag。
import { cellTextArea, locateCell, parseTables, type CellRef, type TableModel } from "./engine.ts"
import { buildMarkdownTable, joinWrapped } from "./extract.ts"
import type { ImplFn, MethodName } from "./runtime.ts"
import { slicePlainByColumn } from "./term-text.ts"

export type DragCtx =
  | { mode: "rect" }
  | { mode: "table"; point: { row: number; col: number; scrollView?: unknown } }

export interface ResolvedTable {
  mode: "single-cell" | "column-locked" | "grid"
  table: TableModel
  rowIdxMin: number
  rowIdxMax: number
  colIdxMin: number
  colIdxMax: number
}

const CTRL_BIT = 16
const MOTION_BIT = 32
const BUTTON_MASK = 3

// ---------- 源行与解析缓存 ----------

function findScrollBox(frame: any, sv: unknown): any {
  const walk = (node: any): any => {
    if (!node) return undefined
    if (node.scrollView === sv) return node
    for (const child of node.children ?? []) {
      const hit = walk(child)
      if (hit) return hit
    }
    return undefined
  }
  return walk(frame?.root ?? frame)
}

function sourceLinesFor(tui: any, scrollView: unknown): readonly string[] {
  if (scrollView) {
    const box = findScrollBox(tui.currentLayout, scrollView)
    if (box?.scrollContentLines) return box.scrollContentLines as readonly string[]
  }
  return (tui.previousScreen as readonly string[] | undefined) ?? []
}

const parseCache = new WeakMap<readonly string[], TableModel[]>()

function parseTablesCached(lines: readonly string[]): TableModel[] {
  let hit = parseCache.get(lines)
  if (!hit) {
    hit = parseTables(lines)
    parseCache.set(lines, hit)
  }
  return hit
}

/** 宽容定位：boundary 端点 col 为开区间，先试 (row, col) 再试 (row, col-1)。 */
function locateCellTolerant(tables: readonly TableModel[], row: number, col: number): CellRef | null {
  return locateCell(tables, row, col) ?? (col > 0 ? locateCell(tables, row, col - 1) : null)
}

// ---------- 状态机 ----------

/**
 * 由 dragCtx + 当前 anchor/focus 解析表格选择模式。
 * 任一环节失效（越界/跨 scrollView/表格消失）→ null（调用方透传原版）。
 */
function resolveTable(tui: any): ResolvedTable | null {
  const drag = tui.__smartSelDrag as DragCtx | null
  if (drag?.mode !== "table") return null
  const focus = tui.selectionFocus as { row: number; col: number; scrollView?: unknown } | undefined
  if (!focus || focus.scrollView !== drag.point.scrollView) return null
  const lines = sourceLinesFor(tui, drag.point.scrollView)
  const tables = parseTablesCached(lines)
  const anchorCell = locateCell(tables, drag.point.row, drag.point.col)
  if (!anchorCell) return null
  const focusCell = locateCellTolerant(tables, focus.row, focus.col)
  if (!focusCell || focusCell.table.topRow !== anchorCell.table.topRow) return null // 越界回退
  const rowIdxMin = Math.min(anchorCell.rowIdx, focusCell.rowIdx)
  const rowIdxMax = Math.max(anchorCell.rowIdx, focusCell.rowIdx)
  const colIdxMin = Math.min(anchorCell.colIdx, focusCell.colIdx)
  const colIdxMax = Math.max(anchorCell.colIdx, focusCell.colIdx)
  const mode =
    rowIdxMin === rowIdxMax && colIdxMin === colIdxMax
      ? "single-cell"
      : colIdxMin === colIdxMax
        ? "column-locked"
        : "grid"
  return { mode, table: anchorCell.table, rowIdxMin, rowIdxMax, colIdxMin, colIdxMax }
}

// ---------- impl 方法 ----------

function handleSelectionMouseEventImpl(tui: any, orig: (...a: any[]) => any, event: any) {
  const isMotion = (event.button & MOTION_BIT) !== 0
  const isPrimaryPress = !event.release && !isMotion && (event.button & BUTTON_MASK) === 0
  const result = orig(event) // 原版先行（release 路径内部完成复制）
  try {
    if (event.release) {
      return result // 保留 dragCtx：pi 复制后保留高亮，语义区域不跳变；下次按下自然重置
    }
    if (!isPrimaryPress) return result
    if ((event.button & CTRL_BIT) !== 0) {
      tui.__smartSelDrag = { mode: "rect" } satisfies DragCtx
      return result
    }
    if (tui.selectionGranularity === "word") {
      tui.__smartSelDrag = null // 双击词选择保持原生
      return result
    }
    const anchor = tui.selectionAnchor as { row: number; col: number; scrollView?: unknown } | undefined
    if (!anchor) {
      tui.__smartSelDrag = null
      return result
    }
    const tables = parseTablesCached(sourceLinesFor(tui, anchor.scrollView))
    const cell = locateCell(tables, anchor.row, anchor.col)
    tui.__smartSelDrag = cell
      ? ({ mode: "table", point: { row: anchor.row, col: anchor.col, scrollView: anchor.scrollView } } satisfies DragCtx)
      : null
  } catch {
    tui.__smartSelDrag = null
  }
  return result
}

function getSelectionBoundsImpl(tui: any, orig: (...a: any[]) => any) {
  const bounds = orig()
  if (!bounds) return bounds
  const r = resolveTable(tui)
  if (!r || r.mode === "single-cell") return bounds // single-cell 用户行本就在格内
  const top = r.table.logicalRows[r.rowIdxMin]!.firstLine
  const bottom = r.table.logicalRows[r.rowIdxMax]!.lastLine
  return {
    start: { ...bounds.start, row: top },
    end: { ...bounds.end, row: bottom },
  }
}

function getSelectionColumnsImpl(
  tui: any,
  orig: (...a: any[]) => any,
  line: string,
  row: number,
  selection: any,
  minColumn?: number,
  maxColumn?: number,
) {
  const drag = tui.__smartSelDrag as DragCtx | null
  // rect 模式：字素/行粒度不矩形化
  if (drag?.mode === "rect" && tui.selectionGranularity === "character" && selection?.start && selection?.end) {
    const lo = Math.min(selection.start.col, selection.end.col)
    const hi = Math.max(selection.start.col, selection.end.col)
    return orig(
      line,
      row,
      { start: { row, col: lo }, end: { row, col: hi, boundary: selection.end.boundary } },
      minColumn,
      maxColumn,
    )
  }
  const r = resolveTable(tui)
  if (!r || !selection) return orig(line, row, selection, minColumn, maxColumn)
  if (r.mode === "single-cell") {
    const [left, right] = cellTextArea(r.table, r.colIdxMin)
    return orig(
      line,
      row,
      selection,
      Math.max(minColumn ?? 0, left),
      Math.min(maxColumn ?? Number.MAX_SAFE_INTEGER, right),
    )
  }
  // column-locked / grid：合成全宽同行选区，min/max 钳到格区间
  const left = r.table.boundaries[r.colIdxMin]! + 2
  const right = r.table.boundaries[r.colIdxMax + 1]! - 1
  return orig(
    line,
    row,
    { start: { row, col: 0 }, end: { row, col: Number.MAX_SAFE_INTEGER, boundary: true } },
    Math.max(minColumn ?? 0, left),
    Math.min(maxColumn ?? Number.MAX_SAFE_INTEGER, right),
  )
}

function getActiveSelectionTextImpl(tui: any, orig: (...a: any[]) => any) {
  const r = resolveTable(tui)
  if (!r) return orig()
  const anchor = tui.selectionAnchor as { scrollView?: unknown } | undefined
  const lines = sourceLinesFor(tui, anchor?.scrollView)
  if (r.mode !== "single-cell") {
    const text = buildMarkdownTable(lines, r.table, r.rowIdxMin, r.rowIdxMax, r.colIdxMin, r.colIdxMax)
    return text.length > 0 ? text : undefined
  }
  // single-cell：行列与高亮严格同源（bounds + 钳制后的 columns）
  const bounds = tui.getSelectionBounds()
  if (!bounds) return orig()
  const parts: string[] = []
  for (let row = bounds.start.row; row <= bounds.end.row; row++) {
    const line = lines[row] ?? ""
    const cols = tui.getSelectionColumns(line, row, bounds)
    parts.push(slicePlainByColumn(line, cols.start, Math.max(0, cols.end - cols.start)))
  }
  const text = joinWrapped(parts)
  return text.length > 0 ? text : undefined
}

function getLineSelectionImpl(tui: any, orig: (...a: any[]) => any, point: any) {
  // 表内三击 = 选中本格全部逻辑内容（对齐 OpenTUI：格内逻辑行即整格）
  const lines = sourceLinesFor(tui, point?.scrollView)
  const cell = locateCell(parseTablesCached(lines), point?.row ?? -1, point?.col ?? -1)
  if (!cell) return orig(point)
  const geom = cell.table.logicalRows[cell.rowIdx]!
  const [left, right] = cellTextArea(cell.table, cell.colIdx)
  return {
    start: { row: geom.firstLine, col: left, scrollView: point.scrollView },
    end: { row: geom.lastLine, col: right, scrollView: point.scrollView, boundary: true },
  }
}

export function buildImpl(): Partial<Record<MethodName, ImplFn>> {
  return {
    handleSelectionMouseEvent: handleSelectionMouseEventImpl,
    getSelectionBounds: getSelectionBoundsImpl,
    getSelectionColumns: getSelectionColumnsImpl,
    getActiveSelectionText: getActiveSelectionTextImpl,
    getLineSelection: getLineSelectionImpl,
  }
}
