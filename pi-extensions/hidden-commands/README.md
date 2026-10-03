# hidden-commands

从 `/` 补全菜单隐藏指定的内置命令。命令本体不受影响，手打仍可调起。

## 配置

编辑 `~/.pi/agent/extensions/hidden-commands/hidden-commands.json`（首次运行自动创建）：

```json
[
  "llama"
]
```

- 元素为命令名，**不带斜杠**。
- 空数组 `[]` = 不隐藏任何命令。
- 修改后在 pi 中执行 `/reload` 生效。
- 配置非法（非 JSON / 顶层不是数组）时退化为不隐藏，并在启动时弹出 warning 提示。

## 机制

通过 `ctx.ui.addAutocompleteProvider()` 链式包装内置补全 provider，按 `label`
过滤掉配置中的命令。只读取 `label`，与其他包装器（如 zh-for-pi 的描述汉化）
的加载顺序无关。`/reload` 后扩展模块重新执行，配置自动刷新。

默认隐藏 `llama`：pi 内置的 llama.cpp router 模型管理面板，不用 llama.cpp
时纯属菜单噪音。
