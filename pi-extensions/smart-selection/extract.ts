// 语义提取与格式化：从重建的表格结构 + 原始渲染行产出干净文本。
import { cellTextArea, type TableModel } from "./engine.ts"
import { slicePlainByColumn } from "./term-text.ts"

/** 软换行智能拼接：接缝两侧均为 ASCII 单词字符补一个空格，否则直连（CJK 安全）。 */
export function joinWrapped(parts: readonly string[]): string {
  let out = ""
  for (const raw of parts) {
    const piece = (out === "" ? raw.trimEnd() : raw.trimStart().trimEnd())
    if (!piece) continue
    if (out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(piece)) {
      out += " " + piece
    } else {
      out += piece
    }
  }
  return out.trim()
}

/** 提取整格逻辑文本（该逻辑行全部物理行 × 文本区）。 */
export function extractFullCell(
  lines: readonly string[],
  table: TableModel,
  rowIdx: number,
  colIdx: number,
): string {
  const geom = table.logicalRows[rowIdx]
  if (!geom) return ""
  const [left, right] = cellTextArea(table, colIdx)
  const parts: string[] = []
  for (let row = geom.firstLine; row <= geom.lastLine; row++) {
    parts.push(slicePlainByColumn(lines[row] ?? "", left, right - left).trimEnd())
  }
  return joinWrapped(parts)
}

/**
 * 多格 → Markdown 表格。
 * 表头恒为真实表头的所选列；数据行为 [max(1,rowIdxMin), rowIdxMax]；
 * 仅覆盖表头时只输出表头与分隔行。
 */
export function buildMarkdownTable(
  lines: readonly string[],
  table: TableModel,
  rowIdxMin: number,
  rowIdxMax: number,
  colIdxMin: number,
  colIdxMax: number,
): string {
  const cols: number[] = []
  for (let c = colIdxMin; c <= colIdxMax; c++) cols.push(c)
  const esc = (s: string) => s.replaceAll("|", "\\|")
  const header = cols.map((c) => esc(extractFullCell(lines, table, 0, c)).trim())
  const out = [`| ${header.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`]
  for (let r = Math.max(1, rowIdxMin); r <= rowIdxMax; r++) {
    const cells = cols.map((c) => esc(extractFullCell(lines, table, r, c)).trim())
    out.push(`| ${cells.join(" | ")} |`)
  }
  return out.join("\n")
}
