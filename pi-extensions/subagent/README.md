# subagent（自托管定制版）

来源：pi-coding-agent@0.84.3 `examples/extensions/subagent/`（官方示例）的本地定制副本。

## 与上游的差异（定制点）

1. 工具 schema 增加可选 `model` 参数（single 顶层 + tasks/chain 每项），透传给 `pi --model`（原生支持 `provider/id:level` 后缀）；
2. `--thinking` 始终传递主会话当前思考级别（仅 `model` 参数带 `:level` 后缀时让位）。上游在 agent 有 frontmatter pin 时会静默丢弃 thinking；
3. 折叠视图用量行显示 `model:thinking`（`formatModelWithThinking`）；
4. Persistent child sessions with parentSession lineage, lightweight parent indexes,
   live JSON transcript reconstruction, and a fullscreen read-only viewer；
5. 用户界面与扩展自身提示使用中文；工具 schema、内部协议值和模型提示保持英文。

本 README 与 `index.ts` 文件头注释为本地新增；两处定制清单应一起维护。`agents.ts` 没有本地定制，仍与上游对应文件对齐，除非以后明确修改。

默认行为（不传 `model`、agent 文件无 pin）：子代理严格以主会话当前模型+思考级别启动。

## 调用与继承

支持三种互斥模式：

- single：`{ agent, task }`；
- parallel：`{ tasks: [{ agent, task }, ...] }`，最多 8 项、并发最多 4；
- chain：`{ chain: [{ agent, task }, ...] }`，后一步任务中的 `{previous}` 会替换为前一步最终文本，失败即停止。

各项仍可指定 `cwd`。默认从 `~/.pi/agent/agents/` 发现 user agents；`agentScope: "project"` 或 `"both"` 才包含最近的 `.pi/agents/`，不受信任项目的 project agents 仍需确认。不要给 agent 文件添加 `model:` frontmatter，否则会脱离主会话模型对齐。

## 持久会话、索引与轻量 details

- 每个 child 在 **`<agentDir>/subagent/sessions/`** 中有独立 JSONL；通常 `<agentDir>` 是 `~/.pi/agent`。child 使用 `--session <预创建文件>` 与 `--session-dir`，没有 `--no-session` fallback。
- 持久 parent 有 session 文件时，child 首行记录该文件的 `parentSession`，但不复制父历史。用于强制落盘的空 bootstrap user message 会被 null `context_edit` 从 canonical projection 省略。
- child store 按 parent session 文件隔离记录；没有持久文件的临时 parent 使用 session id 作为本次运行的 scope。切换 parent 不会清空其他 scope，旧 parent 的 live child 仍按 dispatch scope 更新自己的记录。
- 旧 parent 的 child 在另一 parent 活跃时到达终态，其 terminal index 会进入该 dispatch scope 的内存 pending queue，**不会写入当前新 parent**。重新激活原 parent 时，先 flush 该 scope 的 pending entries，再 fold/restore；flush 失败会保留未写项并明确通知，之后只在同一 parent 重试。
- parent 的 `pi-subagent-child` custom entries 只保存 runId、child ref、模型/任务位置和状态索引，顺序为 `running` 后接 `completed`、`failed` 或 `aborted`；不把完整 transcript 写进 parent。若旧 parent 不再激活，其磁盘索引会暂时保持 `running`，以后重开时按既有的 stale-running 规则恢复为 `unknown`，不会借其他 parent 补写终态。
- 新格式工具结果的每个 `details.results[i].messages` 都是 `[]`，以 `child` ref 关联 store/JSONL。行内展开与 viewer 按需重建 transcript，最终工具 `content` 仍保留模型输出。parallel 单项输出截断时会明确提示完整输出位于 linked child session，而不是 `details.messages`。
- 旧结果若仍含非空 `details.messages`，继续走原行内 renderer；无 child ref 的 legacy 结果不包装点击区域。
- parent 重开时按索引恢复 transcript。恢复读取 active branch 的原始消息，仅通过关联的 null `context_edit` 精确隐藏扩展创建的初始 bootstrap；compaction 不裁剪早期历史，其他 context edit 也不替换或省略只读历史。上次仍停在 `running` 的索引会变为只读 **`unknown`**：不会重连旧进程，也不会把它当成仍在运行。
- 临时 parent（例如 parent 没有持久 session 文件）仍可创建持久 child，但 child header 没有 `parentSession`，parent custom indexes 也无法随 parent 重开。其 session-id scope 和 pending queue 同样只在本次进程内有效，不承诺重启恢复。child JSONL 留在上述目录中，可按路径读取，但不能在这个临时 parent 退出后靠其索引重新发现或恢复 `/subagents` 列表。

## 查看与输入行为

- **`/subagents`**：重新 fold 当前 parent 的索引并恢复快照，以 `1.`, `2.` 等唯一编号列出记录；选择一项打开只读 viewer。相同 description 也按编号对应正确 record。
- **fullscreen 点击**：single 的整个结果卡、parallel/chain 的每个结果行都可用无修饰键的鼠标左键打开对应 child viewer。`Ctrl+O` 仍只负责原行内展开，不是 fullscreen 开关。
- viewer 订阅 child store，按 JSON 事件重建 live reasoning、text、tool call/result，并用 `ScrollView` 的 end-follow 显示；header 显示 agent、状态和已记录的 `model:thinking`。fullscreen overlay 通过 pi 原生 layout engine 按终端高度渲染完整 frame。
- viewer 是只读的：`Esc` 只调用 overlay 的 `done()` 关闭界面，**不会 abort child**。上下键、PgUp/PgDn、Home/End 与 wheel 只滚动；wheel 使用最近一次实际 render 的 layout frame，transcript 的 overscroll 为 `contain`，不会冒泡滚动父 transcript。没有 prompt、continue、send-message 或 abort 控件。
- regular 模式没有这里的 MouseRegion 鼠标点击能力；使用 `/subagents` 进入 viewer，或使用 `Ctrl+O` 查看兼容的行内结果。
- 本版本没有额外控制接口、没有迁移到 RPC，也没有自动后台化语义。工具调用仍使用原 child process 与 AbortSignal 生命周期；恢复历史不等于后台重连或继续执行。

### 恢复错误降级与只读行为

- `PiSessionStorage.read()` 对缺失 child JSONL 抛出包含路径的明确 not-found error，不再把缺失路径恢复成空 session。store 恢复会捕获该错误并写入 `record.error`，viewer 显示错误且保持只读。
- 零字节文件抛出 invalid/empty error，不会被初始化或改写；非空损坏文件继续由 `SessionManager.open()` 的原生校验抛错，同样不会被改写。缺失文件也不会由读取路径创建。
- 流式 abort 时已显示的 partial assistant 文本**不保证写入 child JSONL**；持久恢复以文件中的实际 raw active-branch 历史为准，aborted 索引不代表部分文本已经落盘。

## 自动测试

工作区根目录没有统一依赖清单。以下命令只运行三个不需要宿主 package resolution 的纯测试文件，**不是全部测试**：

```bash
node --test subagent/test/transcript.test.ts subagent/test/child-process.test.ts subagent/test/child-session.test.ts
```

`session-storage.test.ts`、`viewer.test.ts` 和 `host-lifecycle.test.ts` 需要真实 `SessionManager`、pi-tui 及宿主 package resolution，不能在没有依赖的 checkout 中直接加入上述命令后就声称可运行。运行全部六个测试文件时，沿用 Tasks 4/5 的方法：在系统临时目录写一次性 Node loader，将 `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`、`pi-tui`、`@earendil-works/pi-tui/dist/layout.js` 与 `typebox` 映射到**当前已安装 pi host 的 `node_modules`**，再运行：

```bash
TASK6_HOST_ROOT='<pi-host-node_modules>' \
node --experimental-loader 'file:///<temporary-directory>/task6-host-loader.mjs' \
  --test subagent/test/transcript.test.ts subagent/test/child-process.test.ts \
  subagent/test/child-session.test.ts subagent/test/session-storage.test.ts \
  subagent/test/viewer.test.ts subagent/test/host-lifecycle.test.ts
```

loader 只用于测试 package resolution；不要为它在根目录新增 workspace/package.json、安装依赖，或把某台机器的用户路径写进源码。不要用 `pi-main` 的 subagent 测试作为此副本的验收，因为那些测试导入的是上游示例。

## 真实 pi smoke

加载本地扩展、限制 parent 只使用 subagent 工具，并把 JSON 事件保存到临时文件：

```bash
pi --no-extensions -e ./subagent/index.ts \
  --no-mcp --no-skills --no-context-files --tools subagent \
  --mode json -p 'Use subagent exactly once in single mode with agent "worker" and task "Do not use tools; reply with exactly SUBAGENT_SMOKE_OK". Do not do the task yourself; after the tool returns, reply with exactly SUBAGENT_SMOKE_OK.' \
  > '<temporary-directory>/subagent-smoke.jsonl'
```

再把 prompt 改为两个 `tasks` 和两个 `chain` steps，chain 第二步引用 `{previous}`。也可用临时 host loader 直接调用注册工具的 `execute()`，但 child 必须是真实 `pi` CLI 进程。每次至少核验：

1. parent 最终文本、parallel 两项输出与 chain `{previous}` 替换；
2. 每个最终 result 的 `details.messages=[]`、child ref、独立且存在的 JSONL；
3. parent custom indexes 为 running→终态，sessionId/sessionFile/runId 与 result 一致；
4. child header id 不变，持久 parent 的 `parentSession` 指向真实 parent 文件；
5. 用新扩展实例 fold parent indexes 并通过 `PiSessionStorage.read()` 恢复最终文本；
6. 分别制造可靠的 model/startup failure 与真实流式 abort，保留 failed/aborted 索引和实际 transcript 边界。

非 TTY 的 module render、MouseRegion handler 或 mock UI 不能替代真实终端验收。真实鼠标命中、Esc/滚动按键、regular `/subagents`、窄终端、CJK、长 Markdown 与快速 token 更新仍须在交互 TTY 单独验收。

## 维护

- pi 升级后同步：先运行 `npm root -g` 定位全局依赖根，再将 `<npm-root>/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts` 与本地 `index.ts` 做 diff，人工合并上游改动后重新应用上述定制点，并同步更新两处定制清单；managed install 若不在该 npm root，则使用实际安装 release 的对应 package。
- `agents.ts` 当前与上游对齐；同步时保持这一状态，除非有明确、记录的本地改动。
- 1.5.0 已合并上游 `formatReadLineRange()`，用于正确显示数字字符串或 `null` 形式的 read 行号参数。
- agent 定义在 `~/.pi/agent/agents/*.md`，新增时不要写 `model:` 字段（写了会使该 agent 的模型脱离会话对齐）。
- 此目录与全局安装副本相互独立。此处修改不会自动生效；需要运行时使用时，应显式加载本文件或另行同步安装副本并重启 pi，本任务不执行全局同步。
