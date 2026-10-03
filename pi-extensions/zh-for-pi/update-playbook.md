# zh-for-pi 汉化更新操作手册

你被要求把 zh-for-pi 扩展的汉化数据更新到当前安装的 pi 版本。严格按步骤执行，
每步给出确切的数据源与做法。扩展目录见注入本手册的消息前言（下称 EXT）。

## 第 0 步：版本比对（短路检查）

1. 运行 `pi --version` 得到当前版本 V_new。
2. 读 `EXT/items.ts` 头部注释的「对应 pi 版本：x.y.z」得 V_old。
3. 若 V_new == V_old：回复「汉化包已是最新（V_new），无需更新」并**停止**，不做任何修改。

## 第 1 步：定位 pi 的 dist 目录

默认 `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist`（下称 R）。
若不存在，依次尝试：
- `npm root -g` → `<输出>/@earendil-works/pi-coding-agent/dist`
- `readlink -f $(which pi)` 顺藤摸瓜找到安装根

仍找不到：向用户报告并停止。

## 第 2 步：审计设置项（→ items.ts）

1. 读 `R/modes/interactive/components/settings-selector.js`。
   找不到就 `grep -rln "Auto-compact" R --include=*.js | head` 定位新路径。
2. 提取全部条目（id / label / description / values / 是否 submenu），注意真实顺序：
   基础数组按文件中出现顺序；`show-images`、`image-width-cells`、`auto-resize-images`、
   `block-images` 等是后续 `items.splice(...)` 插入的，按 splice 调用顺序重建最终顺序。
3. 每个条目的默认值到 `R/core/settings-manager.js` 查对应 getter 的 `?? <默认值>`。
4. 与 `EXT/items.ts` 的 ITEMS 数组逐项 diff：新增 / 删除 / 描述·默认值·选项变更。
5. 新增条目：翻译后插入正确位置，helper 用法：
   - `tog(id, 中文标签, 中文描述, settings路径数组, 默认boolean, requiresImages?)`
   - `sel(id, 中文标签, 中文描述, settings路径数组, 默认值, [["中文 (raw)", raw], ...])`
   - `sub(id, 中文标签, 中文描述, settings路径数组)`（子菜单）
   删除条目：整段移除。变更条目：同步中文描述与选项。

## 第 3 步：审计斜杠命令（→ commands-zh.ts）

1. 读 `R/core/slash-commands.js`。找不到就 `grep -rln '"Open settings menu"' R --include=*.js | head`。
2. 提取全部 `{ name, description }`（`quit` 的描述含模板变量 APP_NAME，按运行时实际显示翻译）。
3. 与 `EXT/commands-zh.ts` 的 ZH_COMMAND_DESCRIPTIONS diff：
   - 新增命令：补一行 `命令名: "纯中文描述", // 英文原文`
   - 描述变更：更新中文与行尾注释
   - 已删除命令：从表中移除

## 第 4 步：审计快捷键表（→ hotkeys-zh.ts）

1. 在 `R/modes/interactive/interactive-mode.js` 找 `handleHotkeysCommand()`。
   找不到就 `grep -rln "Keyboard Shortcuts" R/modes --include=*.js | head`。
2. 提取模板中 Navigation/Editing/Other 三区的行：键位 id（tui.editor.* / tui.input.* / app.*）、
   字面量键（`/`、`!`、`!!`）、英文文案；注意 newLine 行的 win32 条件文案。
3. 与 `EXT/hotkeys-zh.ts` 的 SECTIONS diff：新增行补翻译（zh 字段），变更行同步。

## 第 4.5 步：审计启动页眉（→ header-zh.ts）

1. 在 `R/modes/interactive/interactive-mode.js` 的 `init()` 中找 `builtInHeader` 模板。
   找不到就 `grep -rln "loaded resources" R --include=*.js | head` 定位。
2. 提取 `expandedInstructions` 全部行（keyHint/rawKeyHint 的键位 id、字面量、英文文案、
   顺序）、`compactInstructions` 全部项、两行 onboarding 文案（compactOnboarding 与
   onboarding 的模板文本）。
3. 与 `EXT/header-zh.ts` diff：`EXPANDED_ROWS`（当前 19 行）、`COMPACT_ROWS`（当前 5 条）、
   `COMPACT_ONBOARDING_ZH`、`ONBOARDING_ZH`。新增行补翻译（zh 字段，风格同 hotkeys-zh）；
   变更行同步；删除行整段移除。键位 id / 字面量段（segments/join）必须随内置同步，
   特殊拼接（`twice`、cycleForward/cycleBackward 对、compact 的 clear/exit 对）对照模板重建。

## 第 4.6 步：审计 bash 渲染文案（→ bash-zh.ts）

1. 读 `R/core/tools/bash.js`，定位 `rebuildBashResultRenderComponent`（渲染逻辑模板）
   与同文件内的 `renderCall`/`renderResult`（state 计时管理）。找不到就
   `grep -rln '"Elapsed"' R --include=*.js | head` 定位。
2. 与 `EXT/bash-zh.ts` 的 `rebuildResultComponent`/`renderCallZh`/`renderResultZh`
   逐段 diff（逻辑必须随内置同步，文案保持中文）：
   - 预览行数常量 `BASH_PREVIEW_LINES`（当前 5）
   - 尾注剥除条件（`!isPartial && truncated && fullOutputPath && output.endsWith("]")`）
   - 收起态预览的缓存组件结构、展开提示行拼接（keyHint("app.tools.expand", ...)）
   - 截断警告两条分支（truncatedBy === "lines" / 字节上限）与 `formatSize` 用法
   - `Elapsed`/`Took` 耗时行条件与位置
   - `formatShellCall` 的 `(timeout Ns)` 后缀与空命令 `"..."` / 无效参数占位
   - `renderResult` 的 setInterval(1000) 驱动与 `endedAt ??=` 收尾
3. 内置若改了渲染逻辑：同步改 bash-zh.ts 的对应实现，中文文案不动。

## 第 4.7 步：审计全屏回到底部提示（→ scroll-indicator-zh.ts）

1. 在 `R/modes/interactive/tui-renderer.js` 的 `createInteractiveTui` fullscreen 分支找
   `scrollToEndIndicator` 模板。找不到就 `grep -rln "Jump to latest" R/modes --include=*.js | head`。
2. 提取：文案模板（当前 ` ↓ Jump to latest message · <键位> `）、键位 id
   （当前 `tui.altScreen.bottom`，默认绑定见 pi-tui keybindings.js 的同名条目）、
   样式（当前 `theme.bg("selectedBg", theme.fg("text", label))`）。
3. 触发与点击行为在 pi-tui 的 `tui-alt-screen.js`：`compositeScrollToEndIndicator`
   （`followEnd && !isFollowingEnd` 时叠加到底部居中）与
   `handleScrollToEndIndicatorMouseEvent`；确认实例属性名 `scrollToEndIndicator` 未改。
   pi-tui 位于 pi 安装根下 `node_modules/@earendil-works/pi-tui/dist/`，找不到就
   `grep -rln "compositeScrollToEndIndicator" <pi 安装根> --include=*.js | head`。
4. 与 `EXT/scroll-indicator-zh.ts` diff：中文文案结构随内置模板同步（键位后缀条件、
   前后空格、`↓` 与 `·` 分隔符保留）；键位 id、样式色名同步。若内置把
   `scrollToEndIndicator` 从实例属性改为其他注入方式，需重审补丁机制
   （文件头注释有完整说明）。

## 第 4.8 步：审计 /mcp 管理器文案（→ mcp-zh.ts）

1. 读 `R/extensions/mcp/index.js` 与 `R/extensions/mcp/ui.js`。找不到就
   `grep -rln "Nothing to show." R --include=*.js | head` 定位（运行时实际加载的是
   `R/bundle/chunks/*.js` 里的压缩版，内容一致，审计以未压缩源为准）。
2. 提取全部用户可见英文文案并与 `EXT/mcp-zh.ts` 的翻译表 diff：
   - 菜单构造器 `serversMenu/serverMenu/showTools/chooseExposure` 的 title/empty/
     details/confirmLabel/cancelLabel、操作项 label 与 description、`saved` 三态、
     `describeState` 全部返回形态（含 `connected · N tools[ · M resources]`、
     `failed: …`）、`EXPOSURE_DESCRIPTIONS` 三条
   - `runAction` 的 status 文案（`Sign in to X`、`Contacting the authorization server…`、
     `Connecting…`、`Reconnecting…`、`Disconnecting…`）
   - `signIn/reconnect/saveConfig` 返回的消息、`notices/reportProblems`、
     `formatStatus` 行、`pickServer/oauthPick/loginCommand/logout/reconnect` 的
     notify/select/input 文案、`MCP_USAGE`、`registerCommand("mcp")` 的 description
     （该 description 在 commands-zh.ts 的 ZH_EXTENSION_COMMAND_DESCRIPTIONS 表中，
     如变更两边同步）
   - `ui.js` 的 `McpManagerView`：`Loading…`、`Nothing to show.`、redirectUrl 页的
     三行提示与 submit/cancel 键位标签（对应 zhRedirectUrl 与 ZH_EXACT）
3. 新增/变更文案：精确句加入 `ZH_EXACT`（或操作项进 `ZH_LABELS`、状态进
   `ZH_STATE_EXACT`），带参句在 `ZH_PATTERNS` 加有序规则——具体消息模式必须排在
   通用标题模式（`^Sign in to (.+)$`、`^MCP server (.+)$` 等）之前。
4. 机制核验：`createMcpExtension` 仍经 `showMcpManager` → `ctx.ui.custom` 创建视图；
   视图类名仍为 `McpManagerView`；`ctx.ui` 仍为 runner.js 的共享 uiContext 包装对象。
   任一不成立需重审拦截机制（文件头注释有完整说明）。

## 第 5 步：翻译风格约定

- select 选项显示为「中文 (英文原值)」，如「逐条 (one-at-a-time)」；专名不译（Mermaid、HTTP、OSC 8、TUI、Tokens 等）
- toggle 选项固定「开 (true)」「关 (false)」（helper 已内置，无需重复）
- 风格参照表中已有条目：简短、动宾结构、不逐字直译
- commands-zh.ts 行尾注释保留英文原文，便于下次 diff

## 第 6 步：版本号与计数同步

把所有「对应 pi 版本：V_old」改为 V_new：
- `EXT/items.ts` 头部注释
- `EXT/commands-zh.ts` 头部注释 + 翻译表上方注释中的「pi x.y.z 英文原文」
- `EXT/hotkeys-zh.ts` 头部注释（若第 4 步定位到了新模板文件，来源路径一并更新）
- `EXT/header-zh.ts` 头部注释（若第 4.5 步定位到了新模板文件，来源路径一并更新）
- `EXT/bash-zh.ts` 头部注释（若第 4.6 步定位到了新模板文件，来源路径一并更新）
- `EXT/scroll-indicator-zh.ts` 头部注释（若第 4.7 步定位到了新模板文件，来源路径一并更新）
- `EXT/mcp-zh.ts` 头部注释（若第 4.8 步定位到了新来源文件，来源路径一并更新）
- `EXT/index.ts` 头部注释
- `EXT/README.md`：版本号行、「N 个条目 + 3 个子菜单」、结构表 items.ts 行的「N 项定义表」
  （N = 更新后 ITEMS 实际条数；命令数/快捷键行数若有变也同步 README 相关数字）

## 第 7 步：验收清单

1. 对每个修改过的 .ts 文件调用 lsp_diagnostics，必须全部无错误
2. 计数核对：ITEMS 条数 == 内置设置条目总数；ZH_COMMAND_DESCRIPTIONS 键数 == 内置命令数；
   EXPANDED_ROWS 行数 == 内置 expandedInstructions 条数；COMPACT_ROWS 条数 == compactInstructions 条数；
   BASH_PREVIEW_LINES == 内置 bash.js 同名常量
3. 向用户输出变更摘要：新增 / 变更 / 删除分别列了哪些条目
4. 提醒用户 `/reload` 或重启 pi 生效

## 范围外（不要动）

- `footer.ts`、`tps-*.ts`：定制代码，与内置定义无机械对应关系
- `bash-zh.ts` 的汉化文案本身（仅随内置渲染逻辑同步结构）
- `settings-io.ts`、`hotkeys-zh.ts` 与 `header-zh.ts` 的格式化/构建纯函数与组件类（仅翻译行定义与文案常量）
