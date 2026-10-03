# prompt-history

为 pi 输入框提供**跨会话持久化**的提示词历史：重启 pi、开新会话后，仍可用 `↑`/`↓` 回溯之前发送过的提示词。

## 行为

- 发送提示词（含 `/命令`、`!bash`）即追加到全局历史文件；
- 光标在输入框首行按 `↑` 翻旧、末行按 `↓` 翻新，未发送草稿自动保存/恢复（完全复用 pi 内置导航交互）；
- 历史全局共享（所有项目目录共用一份），上限 1000 条，导航回溯上限 100 条。

## 安装

将本目录放入 `~/.pi/agent/extensions/` 后重启 pi（或 `/reload`）；也可临时加载：

```bash
pi --extension ~/.pi/agent/extensions/prompt-history
```

## 迁移

拷贝整个 `prompt-history/` 目录到另一台机器的 `~/.pi/agent/extensions/` 即可——历史文件 `history.jsonl` 就在目录内，随目录走。零依赖，目标机只需安装 pi。

## 实现说明

运行时包装 pi 内置 `Editor.prototype` 的 `addToHistory`（持久化）与 `navigateHistory`（首次导航时懒播种磁盘历史）。若未来 pi 版本改动内部方法名，自动降级为「只记录不回溯」，不影响输入。

## 测试

```bash
node --test store.test.ts patch.test.ts
```
