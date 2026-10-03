# subagent（自托管定制版）

来源：pi-coding-agent@0.84.3 `examples/extensions/subagent/`（官方示例）的本地定制副本。

## 与上游的差异（定制点）

1. 工具 schema 增加可选 `model` 参数（single 顶层 + tasks/chain 每项），透传给 `pi --model`（原生支持 `provider/id:level` 后缀）；
2. `--thinking` 始终传递主会话当前思考级别（仅 `model` 参数带 `:level` 后缀时让位）。上游在 agent 有 frontmatter pin 时会静默丢弃 thinking；
3. 折叠视图用量行显示 `model:thinking`（`formatModelWithThinking`）；
4. 本 README 与 index.ts 文件头注释为本地新增。

默认行为（不传 `model`、agent 文件无 pin）：子代理严格以主会话当前模型+思考级别启动。

## 维护

- pi 升级后同步：`diff /home/zk/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/index.ts index.ts`，人工合并上游改动后重新应用上述定制点；
- agent 定义在 `~/.pi/agent/agents/*.md`，新增时不要写 `model:` 字段（写了会使该 agent 的模型脱离会话对齐）；
- 设计规格：`~/.pi/agent/docs/specs/2026-08-28-custom-subagent-extension-design.md`。
