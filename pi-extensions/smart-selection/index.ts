/**
 * smart-selection —— fullscreen 下 Markdown 表格语义选择
 *
 * 加载即更新全局 registry.impl（/reload 热更新核心）；
 * session_start 借隐形 widget 拿 TUI 实例并安装 trampoline（幂等）。
 */
import { buildImpl } from "./impl.ts"
import { getRegistry, install } from "./runtime.ts"

interface UiContext {
  notify(message: string, level?: "info" | "warning" | "error"): void
  setWidget(id: string, factory: (tui: any) => { render: () => string[]; invalidate: () => void }): void
}

interface ExtensionContext {
  mode: string
  ui: UiContext
}

interface ExtensionAPI {
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => void): void
}

export default function (pi: ExtensionAPI) {
  const reg = getRegistry()
  reg.impl = buildImpl() // 关键：模块加载即刷新 impl，trampoline 不变 → /reload 真正热更新

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return
    ctx.ui.setWidget("smart-selection-patch", (tui) => {
      install(tui, (msg) => ctx.ui.notify(msg, "warning"))
      return { render: () => [], invalidate() {} } // 隐形 widget，仅为拿到 tui 引用
    })
  })
}
