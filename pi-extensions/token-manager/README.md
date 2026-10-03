# Token Manager

[pi](https://github.com/earendil-works/pi-coding-agent) 扩展：Kimi For Coding 用量 + DeepSeek 余额 + 阿里云 Token Plan 坐席用量管理。

## 功能

- 状态栏跟随当前模型自动切换：
  - Kimi 模型 → `当前用量 5h: 23% 2h10m 7d: 45% 3d2h`（≥80% 黄，≥95% 红，100% ⛔）
  - DeepSeek 模型 → `deepseek开放平台余额 ¥8.66`（<10 黄，<5 / 不可用 / key 无效红）
  - Token Plan 模型（provider 为 `qwen-token-plan-cn` 或 baseUrl 含 `token-plan.`）→ `当前席位余额 18,432 Credits 12d3h后重置`（按已用百分比着色：≥80% 黄，≥95% 红，100% ⛔）
  - 其他模型 → 不显示
- `/token-manager` 打开三页管理界面（默认第 1 页）：
  - 第 1 页 Kimi 用量：多 key 池，选 key 即热切换 auth.json（无需重启），支持添加/删除/重命名/查看明文/刷新
  - 第 2 页 DeepSeek 余额：总额/赠金/充值明细 + 刷新 + 查看当前 key 明文
  - 第 3 页 Token Plan 坐席：我的坐席 Credits 明细（已用/剩余/周期止），支持配置 AccessKey、绑定/换绑坐席、查看 AK 明文、刷新
- 键位：`↑↓`/`jk` 移动 · `←→`/`hl` 翻页 · `Enter` 选择 · `Esc` 退出
- 当前启用项每 3 分钟自动刷新

## 安装

1. 将本仓库的 `index.ts` 放入 `~/.pi/agent/extensions/token-manager/`（Windows：`%USERPROFILE%\.pi\agent\extensions\token-manager\`）
2. 重启 pi，或在会话内执行 `/reload`

无构建步骤、无第三方依赖：pi 经 jiti 直接加载 TS 源码。

## 配置说明

- **Kimi**：`/token-manager` → 第 1 页 → 添加新 key。池为空时会自动把 auth.json 里现有的 kimi 凭据导入为初始 key
- **DeepSeek**：无需配置，直接读 auth.json 的 `deepseek` 凭据（`$env`/`!cmd` 引用形式无法查询，会显示提示）
- **Token Plan**：`/token-manager` → 第 3 页 → 配置 AccessKey → 按提示绑定"我的坐席"

### provider 匹配规则（可自定义）

扩展按「provider id 或 baseUrl 正则」识别当前模型属于哪家，常量定义在 `index.ts` 顶部：

| 常量 | 默认值 | 说明 |
| --- | --- | --- |
| `KIMI_PROVIDER_ID` / `KIMI_BASE_PATTERN` | `kimi-coding` / `api.kimi.com/coding` | Kimi For Coding |
| `DS_PROVIDER_ID` / `DS_BASE_PATTERN` | `deepseek` / `api.deepseek.com` | DeepSeek |
| `ALI_PROVIDER_ID` / `ALI_BASE_PATTERN` | `qwen-token-plan-cn` / `token-plan..*aliyuncs.com` | 阿里云 Token Plan |

如果你的 provider id 与默认值不同（baseUrl 也不匹配正则），改对应常量后 `/reload` 即可。

## Token Plan 数据源说明

- 查询接口：`GET https://modelstudio.cn-beijing.aliyuncs.com/tokenplan/subscription/seat-detail`（ROA + HMAC-SHA1 签名，XML 响应；非官方公开文档接口，未来可能变动）
- 需要 Token Plan 购买者的 RAM AccessKey：建议授 `AliyunTokenPlanReadOnlyAccess` 只读策略，权限不足再换 `AliyunBailianFullAccess`
- 坐席 Key（sk-sp-）仅用于调用模型，与查询无关，本扩展不保存
- 首次配置 AK 后按提示绑定"我的坐席"（按 SeatId 记忆），状态栏只跟踪该坐席；被回收会提示换绑

## 数据与安全

- 所有密钥存于 `~/.pi/agent/extensions/token-manager/token-manager.keys.json`（文件权限 0600），内容为 Kimi key 池 + `aliyun` 配置（accessKeyId / accessKeySecret / mySeatId）
- **请勿将此文件提交到任何仓库**；fork/搬运本扩展时只带 `index.ts`
- auth.json 的热切换为原子写（临时文件 + rename），不会中断其他 provider 凭据

## 验证（真实凭据）

1. RAM 控制台建子账号 + AccessKey，授只读策略
2. pi 中 `/token-manager` → 第 3 页 → 配置AccessKey → 按提示绑定坐席
3. 状态栏切到 Token Plan 模型，3 分钟内出现用量；与控制台"用量分析"数值核对一致
