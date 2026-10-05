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
  registerCommand(
    name: string,
    def: { description: string; handler: (args: string, ctx: ExtensionContext) => unknown },
  ): void
}

export default function (pi: ExtensionAPI) {
  const reg = getRegistry()
  reg.impl = buildImpl() // 关键：模块加载即刷新 impl，trampoline 不变 → /reload 真正热更新

  pi.registerCommand("smart-selection", {
    description: "smart-selection on|off|status —— 表格语义选择开关",
    handler: (args, ctx) => {
      const cmd = (args ?? "").trim() || "status"
      if (cmd === "on") {
        reg.enabled = true
        ctx.ui.notify("smart-selection: 已启用", "info")
        return
      }
      if (cmd === "off") {
        reg.enabled = false
        ctx.ui.notify("smart-selection: 已关闭（恢复原生选择）", "info")
        return
      }
      const patched = Boolean(reg.orig.handleSelectionMouseEvent)
      ctx.ui.notify(
        `smart-selection: ${reg.enabled ? "启用" : "关闭"}；补丁${patched ? "已安装" : "未安装（需 fullscreen 会话）"}`,
        "info",
      )
    },
  })

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return
    ctx.ui.setWidget("smart-selection-patch", (tui) => {
      install(tui, (msg) => ctx.ui.notify(msg, "warning"))
      return { render: () => [], invalidate() {} } // 隐形 widget，仅为拿到 tui 引用
    })
  })
}
