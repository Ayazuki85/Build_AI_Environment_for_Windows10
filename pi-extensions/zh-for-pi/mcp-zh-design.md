# mcp-zh 设计文档 —— /mcp 管理器汉化（功能九）

日期：2026-10-03 · 对应 pi 版本：1.0.0

## 目标

将内置 `/mcp` 管理器的全部 TUI 页面（服务器列表、单个服务器页、工具列表页、
暴露方式选择页、OAuth 登录页、状态页）及 `/mcp login|logout|reconnect` 的
通知消息汉化为中文，**不修改 pi 的 dist 文件**，pi 升级不丢。

非目标：非 TUI 模式（`pi mcp list` 等 CLI 输出，位于 `cli-QOMC26IJ.js`）、
发给模型的 system prompt 段（`renderServersSection`，保持英文）、MCP 服务器
自己提供的工具描述文本。

## 关键机制验证（已确认）

1. `ctx.ui` 是 `ExtensionRunner.wrapUIPromptContext()` 生成的**同一共享对象**
   （`runner.uiContext`），所有事件与命令处理器（含内置 `/mcp`）经 getter 取到
   同一实例 → 在 `session_start` 包装其 own 方法即覆盖内置 `/mcp`。
   （dist/core/extensions/runner.js:355-369, 614）
2. 内置 `/mcp` 经 `showMcpManager` 调用 `ctx.ui.custom(factory)`，factory 返回
   `McpManagerView` 实例；bundle 中类名保留（`var McpManagerView=class{...}`）
   → 包装 `custom` 后调用原 factory 即可拿到该实例。
   （dist/bundle/chunks/chunk-33XOIQ5N.js；源：dist/extensions/mcp/ui.js）
3. `DynamicBorder`、`keyHint` 均从 `@earendil-works/pi-coding-agent` 公开导出
   → OAuth 页可用公开 API 1:1 重写为中文。

## 架构

两层，全部集中于新文件 `mcp-zh.ts`：

### 翻译层（纯函数，数据驱动）

- `ZH_EXACT: ReadonlyMap<string, string>` — 固定文案精确匹配：
  - 标题/按钮：`MCP servers`→`MCP 服务器`、`Enable`→`启用`、`Sign in`→`登录`、
    `Tools`→`工具`、`Reconnect`→`重新连接`、`Sign out`→`退出登录`、
    `Exposure`→`暴露方式`、`Disable`→`禁用`；底部键位标签
    `manage/close/back/select/save`→`管理/关闭/返回/选择/保存`、`submit/cancel`
  - 固定句：`Nothing to show.`、`This server is no longer configured.`、
    `The server offers no tools.`、`opens the browser`、
    `deletes the stored credentials`、`for this session`、`saved to mcp.json`、
    `Sign-in cancelled.`、三条 EXPOSURE_DESCRIPTIONS 等
- `ZH_PATTERNS: ReadonlyArray<[RegExp, (m: RegExpMatchArray) => string]>` — 带参文案：
  - `connected · 16 tools · direct · global`（describeState + exposure + scope
    三段，状态/scope 翻译，exposure 名保留）
  - `MCP server X` / `Tools of X` / `Exposure of X` / `Sign in to X`
  - `16 offered`、`saved to the global mcp.json`、`State: …`
  - notify 句：`Signed in to MCP server "X" (N tools).`、
    `Reconnected to MCP server "X" (…).`、`MCP servers need attention:…`（多行逐行）、
    `MCP failed to load: …`、`MCP servers are still connecting…` 等
- `translateText(s)`：先精确后模式，**未命中原样返回**（pi 升级新增文案自动回退英文）
- `translateMenu(menu)`：翻译 title/details/error/empty/confirmLabel/cancelLabel/
  items[].label/items[].description；返回新对象不改动原对象
- 状态映射：`connected·N tools`→`已连接·N 个工具`、`disabled`→`已禁用`、
  `needs sign-in`→`需要登录`、`failed`→`失败`、`connecting…`→`连接中…`、
  `starting`→`启动中`；scope 映射 `global`→`全局`、`project`→`项目`、
  `extension`→`扩展`、`config`→`配置`

### 拦截层 `installMcpZhFeature(pi)`

`session_start`（仅 `ctx.mode === "tui"`）时对共享 `ctx.ui` 做幂等包装
（标记属性 `__zhForPiMcpWrapped` 防同对象重复包装；uiContext 重建后自然重装）：

- `custom(factory, options)`：调用原 factory → 检测返回值
  （`constructor.name === "McpManagerView"`，兜底：menu/status/redirectUrl
  三者均为函数）→ 命中则包装实例方法后返回；未命中原样返回
- 实例方法包装：
  - `menu(build, subscribe)` → `originalMenu(() => translateMenu(build()), subscribe)`
  - `status(title, message)` → 两参数各过 `translateText`
  - `redirectUrl(title, authorizationUrl, signal)` → 整页中文重写
    （Container + DynamicBorder + Text + Input + Spacer + hyperlink + keyHint，
    逻辑复刻 dist/extensions/mcp/ui.js 的 redirectUrl：confirm 提交非空输入、
    cancel 返回 undefined、abort 监听、Ctrl/Cmd+click 提示）
- `notify(message, type)`：`translateText` 翻译（多行逐行）后调用原方法
- `select(title, options, opts)` / `input(title, placeholder, opts)`：
  翻译 title（覆盖 pickServer 的 `MCP server` 选择框与 loginCommand 的
  `Waiting for sign-in to "X"…` 输入框）

### 降级

任何一步结构不符（类名/方法缺失、ctx.ui 不可写、menu 字段缺失）→ 静默跳过，
保持内置英文，不影响其他功能；与其他功能共用「session_start 安装、
new/resume/fork/reload 自动重装」约定。

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `mcp-zh.ts`（新增） | 翻译表 + translateText/translateMenu + installMcpZhFeature |
| `index.ts` | +2 行：`installMcpZhFeature(pi)` 及注释（删此行 + /reload 恢复英文） |
| `README.md` | 新增「功能九」一节（机制、已知限制、对应 pi 版本） |
| `update-playbook.md` | 加 mcp-zh.ts 审计条目（对照源：dist/extensions/mcp/index.js、ui.js） |

## 已知限制（写入 README）

- 依赖内部类名 `McpManagerView` 与菜单对象结构；pi 升级若重构 → 特性检测
  静默回退英文
- 暴露方式名（codemode/deferred/direct/hidden）与 scope 路径为配置词汇，保留原文
- MCP 服务器提供的工具名/工具描述不翻译
- 视图构造时的初始 `Loading…` 帧在首个 menu 渲染前存在一瞬，不处理
- 包装挂在共享 uiContext 上，随会话重建消失；`/reload` 即恢复/重装
- 非 TUI 模式的 `pi mcp` CLI 输出不在范围

## 测试

交互式 TUI 无法自动化，实现后由用户按清单手动验证：

1. `/mcp` 列表页：标题、状态行（`已连接 · 16 个工具 · direct · 全局`）、底部 `管理·关闭`
2. 进入 academic-search：详情三行（命令/来源/状态）、操作项中文、底部 `选择·返回`
3. `工具` 页：标题 `academic-search 的工具`、暴露方式说明行
4. `暴露方式` 页：三项说明中文、`保存·返回`，切换后写回 mcp.json 正常
5. `禁用`→`启用`：状态页中文、状态行跟随变化
6. `/mcp login`（若有 OAuth 服务器）：通知与登录页中文
7. 无 MCP 配置时的空列表提示（可临时改名 mcp.json 验证后恢复）
8. 未翻译命中时（如 pi 升级新增文案）回退英文且无报错
