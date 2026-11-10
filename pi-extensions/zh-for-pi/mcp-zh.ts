/**
 * mcp-zh — /mcp 管理器汉化（功能九）
 *
 * 内置行为：`/mcp` 打开 MCP 管理器（dist/extensions/mcp/ 注册，打包进
 * dist/bundle/chunks/chunk-*.js）：服务器列表页（`MCP servers`，状态行如
 * `connected · 16 tools · direct · global`）、单个服务器页（Enable/Sign in/Tools/
 * Reconnect/Sign out/Exposure/Disable + 三行 details）、工具列表页、暴露方式
 * 选择页、OAuth 登录页（redirectUrl）与状态页（Connecting…/Reconnecting…），
 * 另有 `/mcp login|logout|reconnect` 的 notify/select/input 消息。全部为硬编码英文。
 *
 * 机制（与 scroll-indicator-zh 同源的运行时拦截，不改 dist 文件）：
 *   1. ctx.ui 是 ExtensionRunner.wrapUIPromptContext() 生成的同一共享对象
 *      （runner.uiContext，dist/core/extensions/runner.js），所有事件与命令处理器
 *      （含内置 /mcp）经 getter 取到同一实例 → session_start 时包装其 own 方法
 *      custom/notify/select/input 即覆盖内置 /mcp。
 *   2. 内置 showMcpManager 经 ctx.ui.custom(factory) 创建视图，factory 返回
 *      McpManagerView 实例 → 包装 custom 后调用原 factory，按类名/方法集识别
 *      该实例并包装：menu() 的 build 结果过 translateMenu，setContent() 覆盖首个菜单
 *      已启动后的订阅重渲染，status() 参数过 translateText、redirectUrl() 整页中文重写。
 *   3. redirectUrl 重写用公开导出的 DynamicBorder（显式传 color，规避 jiti 双实例
 *      的全局 theme 问题）与复刻的 keyHint（header-zh 的 formatKeyTextLower +
 *      捕获的 live KeybindingsManager，原因同 header-zh.ts 第 131 行注释）。
 *   4. 翻译表为「精确字典 + 有序正则」两层；未命中原样返回英文（pi 升级新增文案
 *      自动回退，不出错）。多行文本整串未命中时逐行翻译。
 *   5. /reload 安全：包装只做一次（holder.wrapped 标记），但翻译实现句柄
 *      holder.impl 每次 session_start 刷新——/reload 后新模块实例的翻译表
 *      立即生效，无需重启。
 *
 * 已知限制：
 * - 依赖内部类名 McpManagerView（bundle 中保留）与菜单对象结构；pi 升级若重构，
 *   特性检测失败静默回退英文，不影响其他功能
 * - 暴露方式名（codemode/deferred/direct/hidden）是写进 mcp.json 的配置词汇，保留原文
 * - MCP 服务器提供的工具名/工具描述不翻译；服务器若恰好叫 Enable/Tools 等字典词，
 *   其名称在列表中会显示为中文（概率极低，可接受）
 * - `/mcp login <Tab>` 补全项里的状态描述走 autocomplete provider，不在本功能范围
 * - 非 TUI 模式的 `pi mcp` CLI 输出（cli.js）不在范围
 * - 要恢复内置英文：删除 index.ts 中 installMcpZhFeature(pi) 一行并 /reload
 *
 * 对应 pi 版本：1.5.1（文案来源：dist/extensions/mcp/index.js 的
 * serversMenu/serverMenu/showTools/chooseExposure/runAction/formatStatus/
 * loginCommand 与 dist/extensions/mcp/ui.js 的 McpManagerView；打包位置可用
 * `grep -ln "Nothing to show." R/bundle/chunks/*.js` 复核）
 * 1.0.3 同步：新增项目覆盖操作项（Enable/Disable in this project、details 的
 * project override 行、列表行 "global, project override" 第三段）；redirectUrl
 * 页随内置改用 AuthUrlComponent 结构（链接行 + 「点击打开 • 键位 复制」提示行，
 * app.message.copy 复制 URL）——内置组件未导出且用全局 theme 单例，此处以捕获的
 * theme 复刻中文版（ZhAuthUrlComponent）。
 * 1.1.0 同步：内置移除 Reconnecting…/Disconnecting… 两条状态页文案（重连/禁用
 * 改走 runInBackground，不再开状态页），对应条目从 ZH_EXACT 删除。
 * 1.2.0 同步：describeState 的已连接+资源形态由「connected · N tools · M resources」
 * （带资源计数）改为「connected · N tools · resources」（仅布尔 hasResources），
 * ZH_STATE_PATTERNS 首条同步更新。
 * 1.5.0 同步：OAuth 默认客户端注册方式变化不涉及可见菜单；McpManagerView、
 * showMcpManager→ctx.ui.custom 与 redirectUrl 结构保持不变，既有翻译继续适用。
 * 1.4.0 同步：文案与机制均无变更（菜单/状态/通知/redirectUrl 全部命中既有翻译表；
 * showMcpManager→ctx.ui.custom→McpManagerView 与 runner.js 共享 uiContext 包装不变）。
 */

import { copyToClipboard, DynamicBorder, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, hyperlink, type Component, type Keybinding } from "@earendil-works/pi-tui";
import { formatKeyTextLower } from "./header-zh.ts";

// ---------------------------------------------------------------------------
// 翻译层（纯函数，数据驱动）
// ---------------------------------------------------------------------------

/** 操作项 label 专用字典（服务器名/工具名不在其中，原样保留） */
const ZH_LABELS: ReadonlyMap<string, string> = new Map([
	["Enable", "启用"],
	["Enable in this project", "在本项目中启用"],
	["Sign in", "登录"],
	["Tools", "工具"],
	["Reconnect", "重新连接"],
	["Sign out", "退出登录"],
	["Exposure", "暴露方式"],
	["Disable", "禁用"],
	["Disable in this project", "在本项目中禁用"],
]);

/** 固定文案精确匹配（整串或逐行） */
const ZH_EXACT: ReadonlyMap<string, string> = new Map([
	// 标题与底部键位标签
	["MCP servers", "MCP 服务器"],
	["MCP server", "MCP 服务器"],
	["manage", "管理"],
	["close", "关闭"],
	["back", "返回"],
	["select", "选择"],
	["save", "保存"],
	// 加载与空态
	["Loading…", "正在加载…"],
	["Nothing to show.", "暂无内容。"],
	["This server is no longer configured.", "该服务器已不再配置。"],
	["The server offers no tools.", "该服务器未提供任何工具。"],
	// 操作项描述
	["opens the browser", "将打开浏览器"],
	["deletes the stored credentials", "删除已保存的凭据"],
	["for this session", "仅本次会话生效"],
	["saved to mcp.json", "已保存到 mcp.json"],
	// 暴露方式说明（EXPOSURE_DESCRIPTIONS）
	["called from codemode scripts, which find them with searchTools()", "由 codemode 脚本调用，脚本用 searchTools() 查找这些工具"],
	["not declared until tool_search loads them, then called directly; no codemode needed", "先不向模型声明，由 tool_search 加载后直接调用；无需 codemode"],
	["declared to the model like built-in tools", "像内置工具一样直接声明给模型"],
	["unreachable", "不可达"],
	["Some tools override it with toolExposure.", "部分工具通过 toolExposure 覆盖了此设置。"],
	// 状态页
	["Contacting the authorization server…", "正在联系授权服务器…"],
	["Connecting…", "正在连接…"],
	// 通知与消息
	["Sign-in cancelled.", "已取消登录。"],
	["Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]", "用法：/mcp、/mcp login [服务器]、/mcp logout [服务器]、/mcp reconnect [服务器]"],
	["No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.", "没有使用 OAuth 的已启用 MCP 服务器。只有不带 Authorization 头的 HTTP 服务器才使用 OAuth。"],
	["No enabled MCP server to reconnect.", "没有可重新连接的已启用 MCP 服务器。"],
	["MCP servers are still connecting; their tools become available once connected.", "MCP 服务器仍在连接中；连接完成后其工具即可使用。"],
	["MCP servers need attention:", "以下 MCP 服务器需要注意："],
	["Run /mcp to fix.", "请运行 /mcp 处理。"],
]);

/** describeState 状态短句（不含参数形态，参数形态见 ZH_STATE_PATTERNS） */
const ZH_STATE_EXACT: ReadonlyMap<string, string> = new Map([
	["disabled", "已禁用"],
	["starting", "启动中"],
	["needs sign-in", "需要登录"],
	["connecting…", "连接中…"],
	["failed", "失败"],
	["connected", "已连接"],
	["disconnected", "已断开"],
	["disconnected, reconnects on next call", "已断开，下次调用时重新连接"],
	["connecting", "连接中…"], // formatStatus 用 connection.state 原值（无省略号）
]);

const ZH_STATE_PATTERNS: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
	[/^connected · (\d+) tools? · resources$/, (m) => `已连接 · ${m[1]} 个工具 · 含资源`],
	[/^connected · (\d+) tools?$/, (m) => `已连接 · ${m[1]} 个工具`],
	[/^failed: ([\s\S]*)$/, (m) => `失败：${m[1]}`],
];

/** scope 词映射（路径原样保留）；"global, project override" 是列表行第三段的组合形态 */
const ZH_SCOPE: ReadonlyMap<string, string> = new Map([
	["global", "全局"],
	["project", "项目"],
	["extension", "扩展"],
	["config", "配置"],
	["global, project override", "全局，项目覆盖"],
]);

function translateState(s: string): string {
	const exact = ZH_STATE_EXACT.get(s);
	if (exact !== undefined) return exact;
	for (const [re, fn] of ZH_STATE_PATTERNS) {
		const m = s.match(re);
		if (m) return fn(m);
	}
	return s;
}

function scopeZh(s: string): string {
	return ZH_SCOPE.get(s) ?? s;
}

/** 带参文案，有序（具体的消息模式在通用的标题模式之前） */
const ZH_PATTERNS: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
	// signIn/saveConfig/reconnect 返回的消息
	[/^MCP server "(.+)" does not use OAuth\.$/, (m) => `MCP 服务器 "${m[1]}" 不使用 OAuth。`],
	[/^MCP server "(.+)" is disabled\.$/, (m) => `MCP 服务器 "${m[1]}" 已禁用。`],
	[/^Sign-in failed: ([\s\S]*)$/, (m) => `登录失败：${m[1]}`],
	[/^Signed in, but ([\s\S]*)$/, (m) => `已登录，但${m[1]}`],
	[/^Could not update (.+): ([\s\S]*)$/, (m) => `无法更新 ${m[1]}：${m[2]}`],
	// 通知
	[/^MCP failed to load: ([\s\S]*)$/, (m) => `MCP 加载失败：${m[1]}`],
	[
		/^MCP tools are only reachable from the codemode or tool_search tool, but neither is active( \(autoEnableCodemode is false\))?; they cannot be called\.$/,
		(m) => `MCP 工具只能通过 codemode 或 tool_search 工具调用，但两者均未激活${m[1] ? "（autoEnableCodemode 为 false）" : ""}，无法调用这些工具。`,
	],
	[/^Sign in to MCP server "(.+)" in your browser:$/, (m) => `请在浏览器中登录 MCP 服务器 "${m[1]}"：`],
	[/^Signed in to MCP server "(.+)" \((\d+) tools?\)\.$/, (m) => `已登录 MCP 服务器 "${m[1]}"（${m[2]} 个工具）。`],
	[/^Signed out of MCP server "(.+)"\.$/, (m) => `已退出 MCP 服务器 "${m[1]}" 的登录。`],
	[/^No stored credentials for MCP server "(.+)"\.$/, (m) => `MCP 服务器 "${m[1]}" 没有已保存的凭据。`],
	[/^Reconnected to MCP server "(.+)" \((.+)\)\.$/, (m) => `已重新连接到 MCP 服务器 "${m[1]}"（${translateState(m[2])}）。`],
	[/^Signing in to MCP server "(.+)" requires interactive mode\.$/, (m) => `登录 MCP 服务器 "${m[1]}" 需要交互模式。`],
	[
		/^Waiting for sign-in to "(.+)"\. If the browser cannot reach this machine, paste the URL it was redirected to\.$/,
		(m) => `正在等待登录 "${m[1]}"。如果浏览器无法访问本机，请粘贴它被重定向到的 URL。`,
	],
	[/^No MCP server named "(.+)"\.$/, (m) => `没有名为 "${m[1]}" 的 MCP 服务器。`],
	[/^No MCP servers configured\. Add them to (.+) or \.pi\/mcp\.json\.$/, (m) => `尚未配置 MCP 服务器。请在 ${m[1]} 或 .pi/mcp.json 中添加。`],
	// formatStatus 行（notify 整体输出时逐行命中）
	[/^(.+): needs sign-in, run \/mcp login (.+) \((\w+)\)$/, (m) => `${m[1]}：需要登录，请运行 /mcp login ${m[2]}（${m[3]}）`],
	[
		/^(.+): (connected|disabled|starting|disconnected|connecting|failed)(?:, (\d+) tools)? \((\w+)\)$/,
		(m) => `${m[1]}：${translateState(m[2])}${m[3] ? `，${m[3]} 个工具` : ""}（${m[4]}）`,
	],
	[/^(\s*)config: (.+)$/, (m) => `${m[1]}配置：${m[2]}`],
	[/^config error: (.+)$/, (m) => `配置错误：${m[1]}`],
	[/^"(.+)" registered by (.+) is overridden by "(.+)" in (.+)$/, (m) => `"${m[1]}"（由 ${m[2]} 注册）被 ${m[4]} 中的 "${m[3]}" 覆盖`],
	[/^overridden: (.+)$/, (m) => `被覆盖：${translateText(m[1])}`],
	// formatStatus 行：disconnected 的完整形态须在通用行之前
	[
		/^(.+): disconnected, reconnects on next call \((\w+)\)$/,
		(m) => `${m[1]}：已断开，下次调用时重新连接（${m[2]}）`,
	],
	// 「以下 MCP 服务器需要注意」的服务器行（保留前导缩进）
	[/^(\s*)(\S.*): (failed: .+|needs sign-in)$/, (m) => `${m[1]}${m[2]}：${translateState(m[3])}`],
	// 菜单标题（放在上面的消息模式之后，避免吞掉整句消息）
	[/^Sign in to (.+)$/, (m) => `登录 ${m[1]}`],
	[/^MCP server (.+)$/, (m) => `MCP 服务器 ${m[1]}`],
	[/^Tools of (.+)$/, (m) => `${m[1]} 的工具`],
	[/^Exposure of (.+)$/, (m) => `${m[1]} 的暴露方式`],
	// 操作项描述
	[/^(\d+) offered$/, (m) => `提供 ${m[1]} 个`],
	[/^saved to the (\w+) mcp\.json$/, (m) => `已保存到${scopeZh(m[1])} mcp.json`],
	// details 行（State 仅在 translateState 认得时才翻译，避免误伤以 "State: " 开头的工具描述）
	[/^project override: (.+)$/, (m) => `项目覆盖：${m[1]}`],
	[
		/^State: (.+)$/,
		(m) => {
			const t = translateState(m[1]);
			return t === m[1] ? m[0] : `状态：${t}`;
		},
	],
	[/^(global|project|extension|config): (.+)$/, (m) => `${scopeZh(m[1])}：${m[2]}`],
	[/^Exposure (\w+): (.+)$/, (m) => `暴露方式 ${m[1]}：${translateText(m[2])}`],
	[/^Applies to this session; the server is registered by (.+)\.$/, (m) => `仅对本次会话生效；该服务器由 ${m[1]} 注册。`],
	[/^Saved to (.+)\.$/, (m) => `将保存到 ${m[1]}。`],
	// 服务器列表行：`状态 · exposure · scope/路径`
	[
		/^(.+) · (codemode|deferred|direct|hidden) · (.+)$/,
		(m) => `${translateState(m[1])} · ${m[2]} · ${scopeZh(m[3])}`,
	],
];

/** 整串翻译：先精确后模式，未命中返回 undefined */
function translateWhole(s: string): string | undefined {
	const exact = ZH_EXACT.get(s);
	if (exact !== undefined) return exact;
	for (const [re, fn] of ZH_PATTERNS) {
		const m = s.match(re);
		if (m) return fn(m);
	}
	return undefined;
}

/** 翻译入口：整串未命中时按行拆分逐行翻译，全部未命中原样返回 */
function translateText(s: string): string {
	if (!s) return s;
	const whole = translateWhole(s);
	if (whole !== undefined) return whole;
	if (!s.includes("\n")) return s;
	let changed = false;
	const lines = s.split("\n").map((line) => {
		const t = translateWhole(line);
		if (t === undefined) return line;
		changed = true;
		return t;
	});
	return changed ? lines.join("\n") : s;
}

/** /mcp 菜单对象的最小结构（dist/extensions/mcp/index.js 的 serversMenu/serverMenu 等） */
interface McpMenuItem {
	value: string;
	label: string;
	description?: string;
}

interface McpMenu {
	title: string;
	details?: string;
	error?: string;
	items: McpMenuItem[];
	empty?: string;
	selected?: string;
	confirmLabel: string;
	cancelLabel: string;
}

function translateLabel(label: string): string {
	return ZH_LABELS.get(label) ?? label;
}

/** 翻译菜单对象（返回新对象；label 仅过操作项字典，服务器名/工具名不受影响） */
function translateMenu(menu: McpMenu): McpMenu {
	return {
		...menu,
		title: translateText(menu.title),
		details: menu.details === undefined ? undefined : translateText(menu.details),
		error: menu.error === undefined ? undefined : translateText(menu.error),
		empty: menu.empty === undefined ? undefined : translateText(menu.empty),
		confirmLabel: translateText(menu.confirmLabel),
		cancelLabel: translateText(menu.cancelLabel),
		items: menu.items.map((item) => ({
			...item,
			label: translateLabel(item.label),
			description: item.description === undefined ? undefined : translateText(item.description),
		})),
	};
}

// ---------------------------------------------------------------------------
// 拦截层
// ---------------------------------------------------------------------------

/** McpManagerView 的最小结构（dist/extensions/mcp/ui.js；字段在编译产物中为公开） */
interface McpManagerViewLike extends Component {
	content: Component;
	tui: { requestRender(): void };
	theme: Theme;
	keybindings: KeybindingsManager;
	menu(build: () => McpMenu, subscribe?: (listener: () => void) => () => void): Promise<string | undefined>;
	status(title: string, message: string, onCancel?: () => void): void;
	redirectUrl(title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined>;
	setContent(content: Component, inputHandler?: (data: string) => void, inputTarget?: unknown): void;
}

/** 翻译实现句柄：存在共享 ctx.ui 上，/reload 后由新模块实例刷新 */
interface ZhImpl {
	translateText: typeof translateText;
	translateLabel: typeof translateLabel;
	translateMenu: typeof translateMenu;
	redirectUrl(view: McpManagerViewLike, title: string, authorizationUrl: string, signal: AbortSignal): Promise<string | undefined>;
}

interface UiWithMcpZh {
	__zhForPiMcp?: { wrapped: boolean; impl: ZhImpl };
}

/** 复刻内置 keyHint（dim 键位 + muted 描述），用捕获的 live theme/keybindings */
function zhKeyHint(theme: Theme, kb: KeybindingsManager, binding: string, label: string): string {
	const keys = kb.getKeys(binding as Keybinding).join("/");
	return theme.fg("dim", formatKeyTextLower(keys)) + theme.fg("muted", ` ${label}`);
}

/**
 * 复刻内置 AuthUrlComponent（dist/modes/interactive/components/auth-url.js）：
 * URL 链接行 + 提示行（「Ctrl+点击打开 • 键位 复制」），app.message.copy 触发 copy()。
 * 内置组件未从包根导出且内部用全局 theme 单例（jiti 双实例问题），故以捕获的
 * theme/keybindings 复刻中文版。
 */
class ZhAuthUrlComponent extends Container {
	private readonly hint: Text;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly url: string,
		private readonly theme: Theme,
		keybindings: KeybindingsManager,
	) {
		super();
		this.addChild(new Text(theme.fg("accent", hyperlink(url, url)), 1, 0));
		this.hint = new Text("", 1, 0);
		this.addChild(this.hint);
		// 原文 keyHint("app.message.copy", "to copy")
		this.setHint(zhKeyHint(theme, keybindings, "app.message.copy", "复制"));
	}

	setHint(suffix: string): void {
		// 原文 process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open"
		const clickHint = process.platform === "darwin" ? "Cmd+点击打开" : "Ctrl+点击打开";
		this.hint.setText(
			`${this.theme.fg("dim", hyperlink(clickHint, this.url))} ${this.theme.fg("dim", "•")} ${suffix}`,
		);
		this.tui.requestRender();
	}

	async copy(): Promise<void> {
		try {
			await copyToClipboard(this.url);
			// 原文 "Copied URL to clipboard"
			this.setHint(this.theme.fg("success", "已复制 URL 到剪贴板"));
		} catch (error) {
			this.setHint(this.theme.fg("error", error instanceof Error ? error.message : String(error)));
		}
	}
}

/**
 * redirectUrl 的中文整页重写（逻辑复刻 dist/extensions/mcp/ui.js：
 * confirm 提交非空输入、cancel/abort 返回 undefined、app.message.copy 复制 URL）。
 */
function zhRedirectUrl(
	view: McpManagerViewLike,
	title: string,
	authorizationUrl: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value?: string) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		};
		const onAbort = () => finish(undefined);
		if (signal.aborted) {
			finish(undefined);
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		const theme = view.theme;
		const keybindings = view.keybindings;
		const input = new Input();
		const link = new ZhAuthUrlComponent(view.tui, authorizationUrl, theme, keybindings);
		const accentBorder = () => new DynamicBorder((text: string) => theme.fg("accent", text));
		const container = new Container();
		container.addChild(accentBorder());
		container.addChild(new Text(theme.fg("accent", theme.bold(translateText(title))), 1, 0));
		container.addChild(new Spacer(1));
		// 原文 "Approve access in your browser. If it did not open, visit:"
		container.addChild(new Text(theme.fg("muted", "请在浏览器中完成授权。如果浏览器没有打开，请访问："), 1, 0));
		container.addChild(link);
		container.addChild(new Spacer(1));
		// 原文 "If the browser runs on another machine, paste the URL it was redirected to:"
		container.addChild(new Text(theme.fg("muted", "如果浏览器运行在另一台机器上，请粘贴它被重定向到的 URL："), 1, 0));
		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg("dim", `${zhKeyHint(theme, keybindings, "tui.select.confirm", "提交")} • ${zhKeyHint(theme, keybindings, "tui.select.cancel", "取消")}`),
				1,
				0,
			),
		);
		container.addChild(accentBorder());
		view.setContent(
			container,
			(data: string) => {
				if (keybindings.matches(data, "tui.select.confirm")) {
					const value = input.getValue().trim();
					if (value) finish(value);
					return;
				}
				if (keybindings.matches(data, "tui.select.cancel")) {
					finish(undefined);
					return;
				}
				// 与内置一致：app.message.copy 复制授权 URL（长 URL 折行后难以整体选中）
				if (keybindings.matches(data, "app.message.copy")) {
					void link.copy();
					return;
				}
				input.handleInput(data);
			},
			input,
		);
	});
}

/** 识别 pi 自己的 McpManagerView：类名优先（bundle 中保留），方法集兜底 */
function isMcpManagerView(value: unknown): value is McpManagerViewLike {
	if (!value || typeof value !== "object") return false;
	if ((value as { constructor?: { name?: string } }).constructor?.name === "McpManagerView") return true;
	const o = value as Record<string, unknown>;
	return (
		typeof o.menu === "function" &&
		typeof o.status === "function" &&
		typeof o.redirectUrl === "function" &&
		typeof o.setContent === "function"
	);
}

/** CSI 样式序列分隔符：仅翻译普通文本段，ANSI 样式原样保留。 */
const ANSI_CSI_SEGMENT = /(\x1B\[[0-?]*[ -/]*[@-~])/g;

/** 翻译带 ANSI 的 Text 内容；保留每个文本段的前后空白。 */
function translateStyledText(text: string, translate: (value: string) => string): string {
	return text
		.split(ANSI_CSI_SEGMENT)
		.map((part, index) => {
			if (index % 2 === 1) return part;
			const match = part.match(/^(\s*)([\s\S]*?)(\s*)$/);
			if (!match?.[2]) return part;
			return `${match[1]}${translate(match[2])}${match[3]}`;
		})
		.join("");
}

/**
 * 翻译 factory 返回前已经同步生成的首屏内容。
 * showMcpManager 在 return view 前调用 manage(view)，首个 menu() 的 render 已完成，
 * 所以只包装后续 menu() 会漏掉首屏。这里按结构遍历 Text / SelectList / Container，
 * 不改服务器值，也不依赖 pi-tui 类实例（bundle 与扩展可能各有一份模块）。
 */
function translateExistingContent(component: unknown, impl: ZhImpl): void {
	if (!component || typeof component !== "object") return;
	const candidate = component as {
		text?: unknown;
		setText?: unknown;
		items?: unknown;
		filteredItems?: unknown;
		children?: unknown;
	};
	if (typeof candidate.text === "string" && typeof candidate.setText === "function") {
		(candidate.setText as (text: string) => void).call(
			component,
			translateStyledText(candidate.text, impl.translateText),
		);
	}
	const seen = new Set<object>();
	for (const list of [candidate.items, candidate.filteredItems]) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || typeof item !== "object" || seen.has(item)) continue;
			seen.add(item);
			const entry = item as { label?: unknown; description?: unknown };
			if (typeof entry.label === "string") entry.label = impl.translateLabel(entry.label);
			if (typeof entry.description === "string") entry.description = impl.translateText(entry.description);
		}
	}
	if (Array.isArray(candidate.children)) {
		for (const child of candidate.children) translateExistingContent(child, impl);
	}
}

/** 包装视图实例的 menu/status/redirectUrl/setContent（幂等）；实现经 holder.impl 间接引用以支持 /reload 刷新 */
function wrapMcpView(view: McpManagerViewLike, holder: { impl: ZhImpl }): void {
	const v = view as McpManagerViewLike & { __zhForPiMcpView?: boolean };
	if (v.__zhForPiMcpView) return;
	v.__zhForPiMcpView = true;
	const origMenu = view.menu.bind(view);
	v.menu = (build, subscribe) => origMenu(() => holder.impl.translateMenu(build()), subscribe);
	const origStatus = view.status.bind(view);
	v.status = (title, message, onCancel) =>
		origStatus(holder.impl.translateText(title), holder.impl.translateText(message), onCancel);
	v.redirectUrl = (title, authorizationUrl, signal) => holder.impl.redirectUrl(view, title, authorizationUrl, signal);
	const origSetContent = view.setContent.bind(view);
	v.setContent = (content, inputHandler, inputTarget) => {
		translateExistingContent(content, holder.impl);
		origSetContent(content, inputHandler, inputTarget);
	};
	// 首个 menu 在 factory 返回前已 render；其订阅重渲染则经过上面的 setContent 包装。
	translateExistingContent(view.content, holder.impl);
	view.invalidate();
}

type UiMethod = (...args: any[]) => any;

/**
 * 包装共享 ctx.ui 的 custom/notify/select/input（幂等）。
 * custom 的 factory 可能同步返回组件或返回 Promise（见 ExtensionUI 类型），两种都接。
 */
function wrapUiContext(ui: Record<string, unknown>): void {
	const holder = ((ui as UiWithMcpZh).__zhForPiMcp ??= {
		wrapped: false,
		impl: { translateText, translateLabel, translateMenu, redirectUrl: zhRedirectUrl },
	});
	holder.impl = { translateText, translateLabel, translateMenu, redirectUrl: zhRedirectUrl };
	if (holder.wrapped) return;
	if (typeof ui.custom !== "function" || typeof ui.notify !== "function") return;

	const origCustom = ui.custom as UiMethod;
	ui.custom = ((factory: (...args: any[]) => unknown, options?: unknown) =>
		origCustom.call(ui, (tui: unknown, theme: unknown, keybindings: unknown, done: unknown) => {
			const produced = factory(tui, theme, keybindings, done);
			const wrapIfMcp = (v: unknown) => {
				try {
					if (isMcpManagerView(v)) wrapMcpView(v, holder);
				} catch {
					/* 包装失败保持英文 */
				}
				return v;
			};
			if (produced && typeof (produced as Promise<unknown>).then === "function") {
				return (produced as Promise<unknown>).then(wrapIfMcp);
			}
			return wrapIfMcp(produced);
		}, options)) as unknown;

	const origNotify = ui.notify as UiMethod;
	ui.notify = ((message: string, ...rest: unknown[]) =>
		origNotify.call(ui, holder.impl.translateText(message), ...rest)) as unknown;

	if (typeof ui.select === "function") {
		const origSelect = ui.select as UiMethod;
		ui.select = ((title: string, ...rest: unknown[]) =>
			origSelect.call(ui, holder.impl.translateText(title), ...rest)) as unknown;
	}
	if (typeof ui.input === "function") {
		const origInput = ui.input as UiMethod;
		ui.input = ((title: string, ...rest: unknown[]) =>
			origInput.call(ui, holder.impl.translateText(title), ...rest)) as unknown;
	}
	holder.wrapped = true;
}

/**
 * session_start 时安装（new/resume/fork/reload 后自动重装；uiContext 重建则重新包装）。
 * 要恢复内置英文：删除 index.ts 中 installMcpZhFeature(pi) 一行并 /reload。
 */
export function installMcpZhFeature(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			wrapUiContext(ctx.ui as unknown as Record<string, unknown>);
		} catch {
			/* 包装失败保持内置英文 */
		}
	});
}
