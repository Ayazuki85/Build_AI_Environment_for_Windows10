// 运行时：全局 registry + 永不变的 trampoline + 装载守卫。
// 热插拔原理：registry 挂在 globalThis[Symbol.for(...)] 上跨 /reload 存活；
// 扩展加载时只替换 registry.impl；trampoline 按调用时刻读取 impl/enabled。

export const METHODS = [
  "handleSelectionMouseEvent",
  "getSelectionBounds",
  "getSelectionColumns",
  "getActiveSelectionText",
  "getLineSelection",
] as const

export type MethodName = (typeof METHODS)[number]
export type ImplFn = (tui: any, orig: (...args: any[]) => any, ...args: any[]) => any

export interface Registry {
  orig: Partial<Record<MethodName, ImplFn>>
  impl: Partial<Record<MethodName, ImplFn>> | null
  enabled: boolean
}

const KEY = Symbol.for("smart-selection.registry")

export function getRegistry(): Registry {
  const g = globalThis as Record<symbol, Registry | undefined>
  g[KEY] ??= { orig: {}, impl: null, enabled: true }
  return g[KEY]
}

export function resetRegistryForTests(): void {
  delete (globalThis as Record<symbol, unknown>)[KEY]
}

function makeTrampoline(name: MethodName) {
  return function (this: unknown, ...args: unknown[]) {
    const reg = getRegistry()
    // Registry 里存的 orig 实为 pi 原始方法（非 ImplFn 形状），按普通变参函数调用
    const orig = reg.orig[name]! as (...args: any[]) => any
    const bound = (...a: unknown[]) => orig.apply(this, a)
    const impl = reg.enabled ? reg.impl?.[name] : undefined
    if (!impl) return bound(...args)
    try {
      return impl(this, bound, ...args)
    } catch {
      return bound(...args)
    }
  }
}

/**
 * 在 TuiAltScreen 实例上安装 trampoline。返回是否激活。
 * 幂等按实例计：以实例自有标记 __smartSelPatched 为准（registry.orig 非空只能说明
 * 别的实例补丁过——pi 的 InteractiveMode 在 fullscreen↔regular 切换时会替换 TuiAltScreen
 * 实例，新实例必须重新装 trampoline）。
 */
export function install(tui: any, notify: (msg: string) => void): boolean {
  if (tui?.mode !== "fullscreen") return false

  const reg = getRegistry()
  if (tui.__smartSelPatched) return true // 本实例已补丁（含 /reload 后 widget 重跑）

  const missing = METHODS.filter((m) => typeof tui[m] !== "function")
  if (missing.length > 0) {
    notify(`smart-selection: pi 内部方法缺失（${missing.join(", ")}），未激活`)
    return false
  }

  if (!reg.orig.handleSelectionMouseEvent) {
    for (const m of METHODS) reg.orig[m] = tui[m] as ImplFn // 首次：捕获原型方法（同类实例共享原型）
  }
  for (const m of METHODS) tui[m] = makeTrampoline(m) // 新实例（渲染器被替换）也要装 trampoline
  tui.__smartSelPatched = true
  return true
}
