# zh-for-pi

## 功能一：/settings的汉化

`/设置` 命令打开全中文设置面板，功能与内置 `/settings` 100% 对齐（34 个条目 + 3 个子菜单，支持顶部搜索），
读写同一个 `~/.pi/agent/settings.json`。

**对应 pi 版本：1.0.0**（条目定义数据驱动，pi 增删设置项时只需改 `items.ts` 一行）。

## 功能二：斜杠命令描述汉化

输入 `/` 时，内置命令的英文描述自动显示为中文（命令名不变，例如
`tree — 浏览会话树（切换分支）`）。机制：包装内置 autocomplete provider，
仅替换描述字段；未收录的命令（如 pi 新版新增）原样显示英文。

翻译表见 `commands-zh.ts`，可按命令名自行追加扩展命令的翻译。
pi 捆绑扩展命令 `/llama`、`/mcp`（dist/extensions/ 注册，非内置命令）已收录在
该文件的 `ZH_EXTENSION_COMMAND_DESCRIPTIONS` 表中，不参与内置命令计数核对。

另：补全项隐藏功能已拆分为独立插件 `hidden-commands`（`~/.pi/agent/extensions/hidden-commands`），
默认隐藏 `llama`，配置文件为 `~/.pi/agent/extensions/hidden-commands/hidden-commands.json`（插件自带数据文件，与 kimi-usage.keys.json 同样随扩展目录存放），修改后 `/reload` 生效。

已知限制：模糊搜索仍按英文命令名匹配（输入中文不过滤）。

## 功能三：/hotkeys的汉化

`/快捷键` 命令在聊天区输出中文版快捷键表（三区 34 行，与内置 `/hotkeys` 对齐），
键位列读取真实生效键位——改过 `keybindings.json` 后显示自定义键位。

机制：`ctx.ui.custom()` 注入的 KeybindingsManager 取键位（同步 done 捕获、零闪烁），
`appendEntry` + entry renderer 渲染（与内置同为聊天记录条目，可滚动回看、不进 LLM 上下文）。
行定义与翻译见 `hotkeys-zh.ts`。

已知限制：

- Extensions 区省略（`getShortcuts` 是 pi 内部 API，扩展无法枚举其他扩展注册的快捷键），
  表格末尾有提示行引导看内置 `/hotkeys`；plan-mode 的快捷键描述已改中文。
- 每次调用向会话文件追加一条持久化 entry（恢复会话时按当时键位快照重渲染），与内置行为一致。

## 功能四：中文 footer（含 TPS 实时速度）

自定义 footer 替代默认 footer：隐藏 cost（`$0.471 (sub)`）与服务商前缀，
stats 行使用中文字段并始终显示全部字段，TPS 段直接内嵌在 stats 行中；
模型名 + 思考等级固定在第三行右对齐，扩展状态（`ctx.ui.setStatus`，如 `DS余额`）
与模型同行、靠左显示，空间不足时优先截断状态。例外：`plan-mode` 扩展的
"计划模式"状态（key 为 `plan-mode`）不拼在第三行，而是右对齐到第一行 cwd 行：

```
~/.pi/agent                                                              计划模式
输入:82k 输出:9.7k 缓存命中率:100.0% TPS:33.0t/s 上下文使用百分比:3.9%/1.0M
DS余额 ¥164.14                                                                  k3 • max
```

- 实时 TPS（可配置滑动窗口，默认 1s），数字不着色，与其他字段同为暗色
- TTFT（首 token 延迟）测量；`/tps` 打开交互式中文设置菜单
  （显示模式 / 服务商 Token 计数 / 计数策略 / 流结束后行为）
- 只有 `edit`/`write` 工具调用计入 token；其他工具调用期间自动暂停计时
- 思考等级文字按等级着色；编辑器边框固定为默认灰（bash 模式仍为绿色）
- 未产生过流式数据时显示 `TPS:--`

TPS 功能合并自 pi-token-speed（MIT，作者 Gabriel Sanhueza）。
配置读取 `settings.json` 的 `"tokenSpeed"` 块（滑动窗口/显示模式/计数策略等），
非法值在会话开始时自动回退默认并弹 warning；`slidingWindow` 限制在 100ms–30s。

已知限制：footer 为整体替换，要恢复默认 footer 需删除 `index.ts` 中
`installFooterFeature(pi)` 一行并重启 pi。

## 功能五：中文启动页眉

启动时 logo 下方的快捷键提示与 onboarding 文案整体替换为中文版，版式与内置
1:1 对齐。收起态：

```
pi v1.0.0
Esc 中断 · ctrl+c/ctrl+d 清空/退出 · / 命令 · ! bash · ctrl+o 更多

Pi 能讲解自己的功能并查阅自己的文档，直接问它怎么用 Pi 或怎么给 Pi 写拓展。
```

ctrl+o 展开为 19 行完整快捷键清单（中断生成 / 清空输入框 / 连按两次退出 / … /
拖入文件添加为附件），再按收起。机制：`session_start` 时 `ctx.ui.setHeader()`
替换内置页眉，组件实现 `setExpanded` 接收 pi 的展开切换；键位列读取真实生效
键位（同 /快捷键 的 `ctx.ui.custom()` 注入方式），改过 `keybindings.json` 后
显示自定义键位。行定义与翻译见 `header-zh.ts`。

已知限制：

- `--verbose` 的初始展开状态扩展无法检测（`getStartupExpansionState` 读内部
  options），中文页眉初始恒为收起态，按一次 ctrl+o 即可展开。
- `quietStartup: true` 时内置页眉为空，本功能跳过安装；`--verbose` +
  安静启动的组合下不会显示中文页眉。
- logo 主名硬编码为 `pi`（内置 APP_NAME 未导出；仅品牌 fork 会不同）。
- 要恢复内置页眉：删除 `index.ts` 中 `installHeaderFeature(pi)` 一行并重启。

## 功能六：bash 工具结果块汉化

bash 工具调用的显示块整体汉化（执行逻辑与内置 100% 同源）：

```
$ npm uninstall pi-questions (超时 60秒)
...（上方还有 15 行，ctrl+o 展开）
<输出预览>
[完整输出: /tmp/pi-bash-xxx.log；已截断: 共 100 行，显示 20 行]
耗时 71.0秒
```

汉化四处：`Elapsed/Took` → `已耗时/耗时`、`(timeout Ns)` → `(超时 N秒)`、
展开提示、截断警告（`完整输出`/`已截断`）。模型看到的工具结果文本保持英文
不受影响（纯 TUI 显示层）。

机制：`pi.registerTool` 同名覆盖内置 bash，execute/参数/schema/系统提示片段来自
公开工厂 `createBashToolDefinition()`，仅 `renderCall`/`renderResult` 两个渲染
槽位换为中文实现（见 `bash-zh.ts`）。展开键位读真实生效键位（同 /快捷键 的
`ctx.ui.custom()` 注入方式），改过 `keybindings.json` 后显示自定义键位。

已知限制：

- 渲染是内置实现的快照：pi 升级若改了 bash 渲染，需用 `/update-zh-for-pi` 同步
- `shellPath`/`shellCommandPrefix` 只读全局 settings.json，不读项目级（安全考虑）
- 仅在 TUI 模式注册覆盖（print/rpc 模式保持内置）
- 要恢复内置英文渲染：删除 `index.ts` 中 `installBashZhFeature(pi)` 一行并 /reload

## 功能七：/update-zh-for-pi 一键汉化更新

pi 升级后在 TUI 输入 `/update-zh-for-pi`：命令读取随附的 `update-playbook.md`
操作手册，通过 `pi.sendUserMessage` 注入会话，由当前 agent 按手册完成全部审计
与更新（提取内置定义 → 对照三张表 → 翻译新条目 → 同步版本号与计数 → 自检汇报）。
命令本身不含提取逻辑；dist 内部结构变化时，agent 按手册中的搜索兜底策略自适应。

手册覆盖：`items.ts`（设置项）、`commands-zh.ts`（命令描述）、`hotkeys-zh.ts`
（快捷键表）、`header-zh.ts`（启动页眉行）、`bash-zh.ts`（bash 渲染文案）、
`scroll-indicator-zh.ts`（全屏回到底部提示）、各文件版本注释与 README 计数。
`footer.ts` / `tps-*.ts` 为定制代码，不在更新范围。

## 功能八：全屏模式「回到底部」提示汉化

全屏模式（`tuiMode: fullscreen`）下向上滚动聊天记录、视口不再跟随最新消息时，
内置会在记录区底部居中叠加英文提示 `↓ Jump to latest message · End`。本功能
将其替换为中文版：

```
↓ 跳转到最新消息 · End
```

键位名跟随真实生效键位（`tui.altScreen.bottom`，默认 End；改过 `keybindings.json`
后显示自定义键位），点击提示或按该键回到底部后自动消失，与内置行为一致。

机制：`session_start` 时经 `ctx.ui.custom()` 捕获真实渲染器（Proxy 的 set /
getPrototypeOf 陷阱落到 pi 自己的实例上），对 pi-tui `TuiAltScreen` 的
`scrollToEndIndicator` 实例属性做补丁——当前实例直接覆盖，原型装存取器吞掉
后续新建实例的英文赋值（见 `scroll-indicator-zh.ts`）。

已知限制：

- 仅全屏模式存在该内置功能；常规模式无此提示，功能静默跳过
- 启动时为常规模式、会话中途才切全屏的极端情况：提示在下次 session_start
  （/reload、/new、/resume 等）前保持英文
- 依赖 pi-tui 内部属性名；pi 升级若改名则静默跳过，不影响其他功能
- 要恢复内置英文：删除 `index.ts` 中 `installScrollIndicatorZhFeature(pi)` 一行
  并**重启 pi**（原型补丁不随 /reload 卸载）

## 功能九：/mcp 管理器汉化

`/mcp` 管理器全部页面汉化：服务器列表（状态行如 `已连接 · 16 个工具 · direct · 全局`）、
单个服务器页（启用/登录/工具/重新连接/退出登录/暴露方式/禁用 + 命令/来源/状态三行详情）、
工具列表页、暴露方式选择页、OAuth 登录页与状态页；`/mcp login|logout|reconnect` 的
通知与选择/输入框同步翻译。翻译表为「精确字典 + 有序正则」两层，未命中的文案
（如 pi 新版新增）原样显示英文，不会报错。

机制：不改 dist 文件。pi 的 `ctx.ui` 是所有事件与命令共享的同一包装对象
（`runner.uiContext`），`session_start` 时包装其 `custom/notify/select/input`：
内置 `/mcp` 经 `ctx.ui.custom()` 创建 `McpManagerView` 时按类名/方法集识别并包装实例——
`menu()` 的菜单对象逐字段翻译（每次重渲染自动生效），`status()` 参数翻译，
`redirectUrl()` 整页中文重写（公开导出的 `DynamicBorder` 显式传 color + 复刻
`keyHint` 用 live theme/keybindings，规避 jiti 双模块单例问题）。翻译实现句柄存于
共享对象，`/reload` 后新翻译表立即生效（包装幂等）。实现见 `mcp-zh.ts`。

已知限制：

- 依赖内部类名 `McpManagerView` 与菜单对象结构；pi 升级若重构，特性检测失败静默回退英文
- 暴露方式名（codemode/deferred/direct/hidden）是写进 mcp.json 的配置词汇，保留原文；
  MCP 服务器提供的工具名/工具描述不翻译
- `/mcp login <Tab>` 补全项里的状态描述走 autocomplete provider，不在本功能范围
- 非 TUI 模式的 `pi mcp` CLI 输出不在范围
- 要恢复内置英文：删除 `index.ts` 中 `installMcpZhFeature(pi)` 一行并 /reload

## 该拓展结构

| 文件               | 职责                                         |
| ---------------- | ------------------------------------------ |
| `settings-io.ts` | settings.json 读写（容错加载、原子写、`.bak` 备份）       |
| `items.ts`       | 34 项定义表（中文标签/描述、选项映射、默认值、字段路径）             |
| `commands-zh.ts` | 斜杠命令翻译表、描述替换纯函数、autocomplete provider 包装器 |
| `hotkeys-zh.ts`  | 快捷键表行定义（3 区 34 行中文翻译）、键位格式化、Markdown 构建纯函数 |
| `header-zh.ts`   | 启动页眉行定义（展开 19 行 / 收起 5 条 + onboarding 文案）、构建纯函数、ZhHeader 组件 |
| `bash-zh.ts`     | bash 工具同名覆盖：中文 renderCall/renderResult（耗时、截断警告、展开提示） |
| `write-zh.ts`    | write 工具同名覆盖：中文 renderCall（截断提示）                    |
| `scroll-indicator-zh.ts` | 全屏「回到底部」提示汉化（TuiAltScreen scrollToEndIndicator 补丁） |
| `mcp-zh.ts`      | /mcp 管理器汉化（共享 ctx.ui 包装 + McpManagerView 菜单翻译 + OAuth 页重写） |
| `footer.ts`      | 中文 footer 渲染、编辑器边框、TPS 事件接线、`/tps` 注册      |
| `tps-engine.ts`  | TPS 测量引擎 + 时间滑动窗口                          |
| `tps-config.ts`  | `tokenSpeed` 配置类型、默认值、校验、settings.json 读写 |
| `tps-command.ts` | `/tps` 交互式设置菜单                             |
| `update-playbook.md` | `/update-zh-for-pi` 注入的操作手册（审计流程、翻译约定、验收清单） |
| `index.ts`       | 命令入口与全部 UI（主面板、3 个子菜单）                     |

## 已知限制

- 面板内列表使用 pi-tui 默认键位（方向键/Enter/Esc）；用户自定义键位不作用于面板（jiti 双模块）
- bash 覆盖工具的 execute 来自 jiti 加载的第二份 dist 模块实例，其启动的 detached 子进程在极端情况下可能不被 pi 退出时统一清理
- 主题自动模式的终端亮/暗检测用 COLORFGBG 环境变量兜底，可能与 pi 的 OSC 查询结果不同（仅影响「当前激活主题」显示）
- 仅读写全局 settings.json，不写项目级 `.pi/settings.json`（与内置 /settings 一致）
- 仅 `show-images`、`image-width-cells` 两项在终端不支持图片时隐藏（与内置一致）
- `/快捷键` 输出不含 Extensions 区（内部 API 不可枚举）；entry 持久化到会话文件
