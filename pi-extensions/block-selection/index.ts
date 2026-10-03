/**
 * block-selection — Ctrl+拖拽矩形（列）选择
 *
 * 解决痛点：fullscreen 模式下 pi 的拖拽选择是线性跨度，中间行恒取全宽，
 * 在渲染后的 markdown 表格里做多行选择时会把左侧列的内容一并圈入。
 * 本扩展按住 Ctrl 拖拽时把选区钳制为矩形（起止列的最小/最大列范围），
 * 高亮与复制路径（getSelectionColumns）自动一致，松手按原逻辑自动复制。
 *
 * 原理（不改动 pi 本体，升级 npm 包不受影响）：
 * - session_start 时借 setWidget 的 factory 同步拿到 TUI 实例（隐形 0 行 widget）；
 * - 猴子补丁实例上的 handleSelectionMouseEvent：新按下时记录 Ctrl 修饰位；
 * - 猴子补丁实例上的 getSelectionColumns：block 模式下用合成同行选区
 *   回调原版方法做字素级列对齐（CJK 宽字符安全），否则透传原逻辑。
 *
 * 守卫：仅 fullscreen（TuiAltScreen）生效；内部方法缺失（pi 升级改名）时
 * 静默跳过并警告一次；__blockSelectionPatched 旗标保证 /reload 幂等。
 *
 * 对应 pi 版本：0.85.1
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** SGR 鼠标编码：bit 3 (8)=Alt，bit 4 (16)=Ctrl，bit 5 (32)=motion/drag */
const CTRL_BIT = 16;
const MOTION_BIT = 32;

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: unknown;
	boundary?: boolean;
}

interface SelectionSpan {
	start: SelectionPoint;
	end: SelectionPoint;
}

interface RawMouseEvent {
	button: number;
	x: number;
	y: number;
	release?: boolean;
}

interface PatchableTui {
	mode?: string;
	selectionGranularity?: string;
	__blockSelCtrl?: boolean;
	__blockSelectionPatched?: boolean;
	handleSelectionMouseEvent?: (event: RawMouseEvent) => unknown;
	getSelectionColumns?: (
		line: string,
		row: number,
		selection: SelectionSpan,
		minColumn?: number,
		maxColumn?: number,
	) => { start: number; end: number };
}

function patchTui(tui: PatchableTui, notify: (msg: string) => void): void {
	if (tui.__blockSelectionPatched) return;
	if (tui.mode !== "fullscreen") return; // regular 模式由终端原生选择接管
	if (
		typeof tui.handleSelectionMouseEvent !== "function" ||
		typeof tui.getSelectionColumns !== "function"
	) {
		notify("block-selection: pi 内部结构已变化，矩形选择补丁未生效");
		return;
	}

	const origHandle = tui.handleSelectionMouseEvent;
	const origCols = tui.getSelectionColumns;

	tui.handleSelectionMouseEvent = function (this: PatchableTui, event: RawMouseEvent) {
		// 新一次按下（非释放、非拖拽移动）时记录 Ctrl 修饰位；
		// 不按 Ctrl 的拖拽保持原线性行为不变。
		if (!event.release && (event.button & MOTION_BIT) === 0) {
			this.__blockSelCtrl = (event.button & CTRL_BIT) !== 0;
		}
		return origHandle.call(this, event);
	};

	tui.getSelectionColumns = function (
		this: PatchableTui,
		line: string,
		row: number,
		selection: SelectionSpan,
		minColumn?: number,
		maxColumn?: number,
	) {
		if (
			this.__blockSelCtrl &&
			this.selectionGranularity === "character" && // 双击/三击的词、行选择不矩形化
			selection?.start &&
			selection?.end
		) {
			const lo = Math.min(selection.start.col, selection.end.col);
			const hi = Math.max(selection.start.col, selection.end.col);
			// 合成"同行选区"回调原版：每行都得到 [lo, hi] 的字素对齐钳制
			return origCols.call(
				this,
				line,
				row,
				{ start: { row, col: lo }, end: { row, col: hi, boundary: selection.end.boundary } },
				minColumn,
				maxColumn,
			);
		}
		return origCols.call(this, line, row, selection, minColumn, maxColumn);
	};

	tui.__blockSelectionPatched = true;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return; // 仅交互式 TUI；rpc/print 模式无选择语义
		ctx.ui.setWidget("block-selection-patch", (tui) => {
			patchTui(tui as unknown as PatchableTui, (msg) => ctx.ui.notify(msg, "warning"));
			return { render: () => [], invalidate() {} }; // 隐形 widget，仅为拿到 tui 引用
		});
	});
}
