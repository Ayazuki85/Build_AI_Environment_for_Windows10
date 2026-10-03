/**
 * scroll-indicator-zh — 全屏模式「回到底部」浮动提示汉化
 *
 * 内置行为（仅 fullscreen 模式）：向上滚动、视口不再跟随最新消息时，记录区底部
 * 居中叠加显示 ` ↓ Jump to latest message · End `（pi-tui TuiAltScreen 每帧调用
 * 实例属性 scrollToEndIndicator() 取文案并合成到屏幕缓冲；鼠标点击该提示或按
 * tui.altScreen.bottom 键位（默认 End）回到底部后消失）。文案工厂由 pi 在
 * createInteractiveTui 的 fullscreen 分支中硬编码为英文
 * （dist/modes/interactive/tui-renderer.js），本功能将其替换为中文版：
 *   ↓ Jump to latest message · End   →   ↓ 跳转到最新消息 · End
 *
 * 机制：session_start 时经 ctx.ui.custom() 捕获（同步 done、零闪烁，同 header-zh.ts）。
 * 工厂收到的 tui 是转发到当前真实渲染器的 Proxy——其 set 陷阱会 Reflect.set 到
 * 真实实例、getPrototypeOf 陷阱返回真实实例的原型。据此做双层补丁：
 *   1. 当前实例：tui.scrollToEndIndicator = zhFactory（覆盖构造器写入的英文回调）
 *   2. 原型存取器：Object.getPrototypeOf(tui) 上 defineProperty——getter 返回存于
 *      原型上的最新中文工厂，setter 吞掉构造器的英文赋值（createInteractiveTui 每次
 *      新建 TuiAltScreen 都会执行该赋值）；会话中途 regular→fullscreen 切换新建的
 *      实例因此自动生效。不能 import { TuiAltScreen } 改类：jiti 会加载第二份 pi-tui
 *      模块实例（见 bash-zh.ts 头注释），必须经 Proxy 拿 pi 自己的那份。
 * 键位与主题每次调用动态读取（捕获 live theme 单例与真实 KeybindingsManager），
 * 改 keybindings.json 或切换主题即时生效；键位未绑定时不显示「· 键位」后缀（同内置）。
 *
 * 已知限制：
 * - 仅 fullscreen 模式存在该内置功能；regular 模式无此提示，本功能静默跳过
 * - 启动时为 regular、会话中途才切 fullscreen 的极端情况：提示在下次 session_start
 *   （/reload、new、resume 等）前保持英文
 * - 依赖 pi-tui 内部属性名 scrollToEndIndicator / mode；pi 升级若改名则特性检测
 *   失败、静默跳过，不影响其他功能
 * - 要恢复内置英文：删除 index.ts 中 installScrollIndicatorZhFeature(pi) 一行并
 *   重启 pi（原型补丁不随 /reload 卸载）
 *
 * 对应 pi 版本：1.0.0（文案模板见 dist/modes/interactive/tui-renderer.js 的
 * scrollToEndIndicator；触发条件见 pi-tui tui-alt-screen.js 的
 * compositeScrollToEndIndicator：followEnd && !isFollowingEnd 时叠加到底部居中）
 */

import type { ExtensionAPI, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Keybinding } from "@earendil-works/pi-tui";
import { formatKey } from "./hotkeys-zh.ts";

/** 内置回到底部提示的键位 id（pi-tui 默认绑定 end；显示格式同内置 keyDisplayText） */
const BOTTOM_KEYBINDING = "tui.altScreen.bottom";

type ScrollIndicatorFactory = () => string;

/** TUI Proxy 的最小结构化子集（scrollToEndIndicator 是 pi-tui 内部属性，不在公开类型上） */
interface PatchableTui {
	mode?: string;
	scrollToEndIndicator?: ScrollIndicatorFactory;
}

/** 原型上的补丁标记与最新中文工厂句柄（跨 /reload 的模块实例共享，因原型属 pi 那份模块） */
interface ScrollIndicatorProto {
	__zhForPiScrollFactory?: ScrollIndicatorFactory;
	__zhForPiScrollPatched?: boolean;
}

/** 中文文案工厂：结构复刻内置 ` ↓ Jump to latest message · End ` + selectedBg/text 样式 */
function buildZhFactory(theme: Theme, kb: KeybindingsManager): ScrollIndicatorFactory {
	return () => {
		const keys = kb.getKeys(BOTTOM_KEYBINDING as Keybinding);
		const shortcut = keys.length > 0 ? formatKey(keys.join("/")) : "";
		const label = ` ↓ 跳转到最新消息${shortcut ? ` · ${shortcut}` : ""} `;
		return theme.bg("selectedBg", theme.fg("text", label));
	};
}

/**
 * 双层补丁（幂等）：当前实例直接覆盖；原型装存取器覆盖未来实例。
 * 工厂句柄存在原型上：/reload 后新模块实例只需刷新句柄，既有 getter 自动取到最新工厂。
 */
function patchScrollIndicator(tui: PatchableTui, theme: Theme, kb: KeybindingsManager): void {
	// 特性检测：仅 fullscreen 渲染器（TuiAltScreen）有该内部属性；regular 模式静默跳过
	if (tui.mode !== "fullscreen" || !("scrollToEndIndicator" in tui)) return;
	const proto = Object.getPrototypeOf(tui) as ScrollIndicatorProto;
	proto.__zhForPiScrollFactory = buildZhFactory(theme, kb);
	if (!proto.__zhForPiScrollPatched) {
		Object.defineProperty(proto, "scrollToEndIndicator", {
			configurable: true,
			get() {
				return proto.__zhForPiScrollFactory;
			},
			set(_value: unknown) {
				// 吞掉构造器 / createInteractiveTui 写入的英文工厂
			},
		});
		proto.__zhForPiScrollPatched = true;
	}
	// 当前实例：构造器在补丁前已写入英文 own 属性，直接覆盖（Proxy set → 真实实例）
	tui.scrollToEndIndicator = proto.__zhForPiScrollFactory;
}

/**
 * session_start 时安装（new/resume/fork/reload 后自动重装）。
 * 要恢复内置英文：删除 index.ts 中 installScrollIndicatorZhFeature(pi) 一行并重启 pi。
 */
export function installScrollIndicatorZhFeature(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			// 同步 done 捕获真实渲染器/theme/keybindings，零闪烁（同 header-zh.ts）
			await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
				done(undefined);
				patchScrollIndicator(tui as PatchableTui, theme, keybindings);
				return new Container();
			});
		} catch {
			/* 捕获失败保持内置英文 */
		}
	});
}
