/**
 * zh-for-pi — 中文设置面板 + 中文 footer
 *
 * /设置：以中文查看和修改 pi 设置，读写同一个 ~/.pi/agent/settings.json，
 * 条目与内置 /settings 面板 100% 对齐（34 项 + 3 个子菜单，支持搜索）。
 * 另含：斜杠命令描述汉化、/快捷键 中文表、中文 footer（含 TPS，见 footer.ts）、
 * 中文启动页眉（logo 下快捷键提示 + onboarding 文案，ctrl+o 可展开，见 header-zh.ts）、
 * bash 工具结果块汉化（耗时/截断警告/展开提示，同名覆盖内置 bash，见 bash-zh.ts）、
 * write 工具调用块汉化（截断提示，同名覆盖内置 write，见 write-zh.ts）、
 * 全屏模式「回到底部」浮动提示汉化（滚离底部时显示 ↓ 跳转到最新消息，见 scroll-indicator-zh.ts）。
 *
 * 对应 pi 版本：1.0.0
 */
import {
	DynamicBorder,
	getAgentDir,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import {
	Container,
	fuzzyFilter,
	getCapabilities,
	getKeybindings,
	Input,
	Markdown,
	SelectList,
	Spacer,
	Text,
	type Component,
	type Keybinding,
	type SelectItem,
	type SettingItem,
	SettingsList,
} from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBashZhFeature } from "./bash-zh.ts";
import { installWriteZhFeature } from "./write-zh.ts";
import { installScrollIndicatorZhFeature } from "./scroll-indicator-zh.ts";
import { installMcpZhFeature } from "./mcp-zh.ts";
import { wrapProvider } from "./commands-zh.ts";
import { installFooterFeature } from "./footer.ts";
import { installHeaderFeature } from "./header-zh.ts";
import { buildHotkeysMarkdown, HOTKEYS_ENTRY_TYPE, type HotkeysEntryData } from "./hotkeys-zh.ts";
import {
	currentRaw,
	displayForRaw,
	ITEMS,
	modelThinkingSummary,
	rawForDisplay,
	visibleItems,
	type ItemDef,
} from "./items.ts";
import {
	getByPath,
	loadSettings,
	saveSettings,
	setByPath,
	type SettingsObject,
} from "./settings-io.ts";

interface PanelDeps {
	ctx: ExtensionCommandContext;
	pi: ExtensionAPI;
	settings: SettingsObject;
	theme: Theme;
	save: () => void;
	markDirty: () => void;
	notifySaved: () => void;
}

// —— 主面板 ——

function buildSettingItem(def: ItemDef, deps: PanelDeps): SettingItem {
	if (def.type === "submenu") {
		return buildSubmenuItem(def, deps);
	}
	return {
		id: def.id,
		label: def.label,
		description: def.description,
		currentValue: displayForRaw(def, currentRaw(def, deps.settings)),
		values: def.options.map((o) => o.display),
	};
}

function buildSubmenuItem(def: ItemDef, deps: PanelDeps): SettingItem {
	switch (def.id) {
		case "warnings":
			return {
				id: def.id,
				label: def.label,
				description: def.description,
				currentValue: "配置",
				submenu: (_currentValue, done) => new WarningsSubmenu(deps, () => done()),
			};
		case "model-thinking": {
			const stored = getByPath(deps.settings, ["modelThinkingLevels"]);
			const overrides =
				stored !== null && typeof stored === "object" && !Array.isArray(stored)
					? (stored as Record<string, string>)
					: {};
			return {
				id: def.id,
				label: def.label,
				description: def.description,
				currentValue: modelThinkingSummary(overrides),
				submenu: (_currentValue, done) =>
					new ModelThinkingSubmenu(deps, deps.ctx.modelRegistry.getAvailable(), (summary) => done(summary)),
			};
		}
		case "theme": {
			const stored = getByPath(deps.settings, ["theme"]);
			const setting = typeof stored === "string" && stored.length > 0 ? stored : "dark";
			return {
				id: def.id,
				label: def.label,
				description: def.description,
				currentValue: setting,
				submenu: (_currentValue, done) => new ThemeSubmenu(deps, (value) => done(value)),
			};
		}
		default:
			throw new Error(`未知子菜单: ${def.id}`);
	}
}

/** 主列表 onChange：toggle/select 写 settings.json 并标记需重载；submenu 项直接忽略（由子菜单自管） */
function onValueChange(id: string, newDisplay: string, deps: PanelDeps): void {
	const def = ITEMS.find((d) => d.id === id);
	if (!def || def.type === "submenu") return;
	const raw = rawForDisplay(def, newDisplay);
	if (raw === undefined) return;
	setByPath(deps.settings, def.path, raw);
	deps.save();
	deps.markDirty();
	deps.notifySaved();
}

// —— warnings 子菜单 ——

class WarningsSubmenu extends Container {
	private readonly list: SettingsList;

	constructor(deps: PanelDeps, onClose: () => void) {
		super();
		const current = getByPath(deps.settings, ["warnings", "anthropicExtraUsage"]);
		const enabled = typeof current === "boolean" ? current : true; // pi 默认 true
		this.list = new SettingsList(
			[
				{
					id: "anthropic-extra-usage",
					label: "Anthropic 额外用量警告",
					description: "Anthropic 订阅授权可能产生付费额外用量时显示警告",
					currentValue: enabled ? "开 (true)" : "关 (false)",
					values: ["开 (true)", "关 (false)"],
				},
			],
			1,
			getSettingsListTheme(),
			(_id, newValue) => {
				setByPath(deps.settings, ["warnings", "anthropicExtraUsage"], newValue === "开 (true)");
				deps.save();
				deps.markDirty();
				deps.notifySaved();
			},
			onClose,
		);
		this.addChild(this.list);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
}

// —— SelectStep：单步选择子菜单（SelectSubmenu 同类物，中文提示）——

const SELECT_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

class SelectStep extends Container {
	private selectList: SelectList;
	private readonly listChildIndex: number;
	private readonly allOptions: SelectItem[];
	private readonly searchInput?: Input;
	private readonly onSelectCb: (value: string) => void;
	private readonly onCancelCb: () => void;
	private readonly onSelectionChangeCb?: (value: string) => void;

	constructor(
		theme: Theme,
		options: {
			title: string;
			description?: string;
			items: SelectItem[];
			preselect?: string;
			searchable?: boolean;
			onSelect: (value: string) => void;
			onCancel: () => void;
			onSelectionChange?: (value: string) => void;
		},
	) {
		super();
		this.allOptions = options.items;
		this.onSelectCb = options.onSelect;
		this.onCancelCb = options.onCancel;
		this.onSelectionChangeCb = options.onSelectionChange;

		this.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 0, 0));
		if (options.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", options.description), 0, 0));
		}
		if (options.searchable) {
			this.addChild(new Spacer(1));
			this.searchInput = new Input();
			this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
			this.addChild(this.searchInput);
		}
		this.addChild(new Spacer(1));
		this.selectList = this.buildList(options.items, options.preselect ?? "");
		this.listChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		const hint = options.searchable ? "  输入以过滤 · Enter 选择 · Esc 返回" : "  Enter 选择 · Esc 返回";
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
	}

	private buildList(items: SelectItem[], preselect: string): SelectList {
		const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme(), SELECT_LAYOUT);
		const index = items.findIndex((o) => o.value === preselect);
		if (index !== -1) list.setSelectedIndex(index);
		list.onSelect = (item) => this.onSelectCb(item.value);
		list.onCancel = this.onCancelCb;
		const onChange = this.onSelectionChangeCb;
		if (onChange) list.onSelectionChange = (item) => onChange(item.value);
		return list;
	}

	private applyFilter(query: string): void {
		const filtered = query
			? fuzzyFilter(this.allOptions, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allOptions;
		const list = this.buildList(filtered, "");
		this.children[this.listChildIndex] = list;
		this.selectList = list;
	}

	handleInput(data: string): void {
		if (this.searchInput) {
			// 扩展侧 getKeybindings() 为默认键位（jiti 双模块），方向键/Enter/Esc 可用
			const kb = getKeybindings();
			const isNav =
				kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.confirm") ||
				kb.matches(data, "tui.select.cancel");
			if (isNav) {
				this.selectList.handleInput(data);
			} else {
				this.searchInput.handleInput(data);
				this.applyFilter(this.searchInput.getValue());
			}
			return;
		}
		this.selectList.handleInput(data);
	}
}

// —— model-thinking 两步子菜单（选模型 → 选级别，完成后循环回模型列表）——

const CLEAR_OVERRIDE_VALUE = "__clear__";
const NO_MODELS_VALUE = "__none__";

const THINKING_LEVEL_ZH: Record<string, string> = {
	off: "不推理",
	minimal: "极短推理（约 1k tokens）",
	low: "轻度推理（约 2k tokens）",
	medium: "中等推理（约 8k tokens）",
	high: "深度推理（约 16k tokens）",
	xhigh: "超高推理（约 32k tokens）",
	max: "最大推理",
};

type ThinkingLevelValue = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

class ModelThinkingSubmenu extends Container {
	private active: SelectStep;

	constructor(
		private readonly deps: PanelDeps,
		private readonly models: readonly Model<any>[],
		private readonly onClose: (summary: string) => void,
	) {
		super();
		this.active = this.buildModelStep();
	}

	/** 当前覆盖表（settings.json 的 modelThinkingLevels，缺省为 {}） */
	private overrides(): Record<string, string> {
		const value = getByPath(this.deps.settings, ["modelThinkingLevels"]);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? { ...(value as Record<string, string>) }
			: {};
	}

	private globalDefaultLevel(): string {
		const value = getByPath(this.deps.settings, ["defaultThinkingLevel"]);
		return typeof value === "string" ? value : "medium"; // pi 的 DEFAULT_THINKING_LEVEL
	}

	private buildModelStep(): SelectStep {
		const overrides = this.overrides();
		const currentKey = this.deps.ctx.model ? modelKey(this.deps.ctx.model) : undefined;
		const defaultProvider = getByPath(this.deps.settings, ["defaultProvider"]);
		const defaultModel = getByPath(this.deps.settings, ["defaultModel"]);
		const defaultKey =
			typeof defaultProvider === "string" && typeof defaultModel === "string"
				? `${defaultProvider}/${defaultModel}`
				: undefined;

		// 排序与内置一致：当前模型最前，其次默认模型，再按 provider 字典序
		const sorted = [...this.models].sort((a, b) => {
			const aKey = modelKey(a);
			const bKey = modelKey(b);
			if (aKey === currentKey) return -1;
			if (bKey === currentKey) return 1;
			if (aKey === defaultKey) return -1;
			if (bKey === defaultKey) return 1;
			return a.provider.localeCompare(b.provider);
		});

		const items: SelectItem[] = sorted.map((model) => {
			const key = modelKey(model);
			return { value: key, label: `${model.id} [${model.provider}]`, description: overrides[key] };
		});
		if (items.length === 0) {
			items.push({ value: NO_MODELS_VALUE, label: "无可用模型", description: "请先登录提供商或配置 API key" });
		}

		return new SelectStep(this.deps.theme, {
			title: "每模型默认思考级别",
			description: "选择要配置的模型",
			items,
			preselect: currentKey ?? defaultKey ?? "",
			searchable: true,
			onSelect: (value) => {
				if (value === NO_MODELS_VALUE) return;
				this.active = this.buildLevelStep(value);
			},
			onCancel: () => this.onClose(modelThinkingSummary(this.overrides())),
		});
	}

	private buildLevelStep(key: string): SelectStep {
		const model = this.models.find((m) => modelKey(m) === key);
		if (!model) return this.buildModelStep();

		const overrides = this.overrides();
		const levels: string[] = model.reasoning ? [...getSupportedThinkingLevels(model)] : ["off"];
		const items: SelectItem[] = levels.map((level) => ({
			value: level,
			label: level,
			description: THINKING_LEVEL_ZH[level],
		}));
		if (overrides[key] !== undefined) {
			items.push({
				value: CLEAR_OVERRIDE_VALUE,
				label: "（清除覆盖）",
				description: `恢复全局默认（${this.globalDefaultLevel()}）`,
			});
		}

		return new SelectStep(this.deps.theme, {
			title: `${model.id} 的思考级别`,
			description: "为该模型选择默认思考级别",
			items,
			preselect: overrides[key] ?? "",
			onSelect: (value) => {
				const next = this.overrides();
				if (value === CLEAR_OVERRIDE_VALUE) {
					delete next[key];
				} else {
					next[key] = value;
				}
				setByPath(this.deps.settings, ["modelThinkingLevels"], next);
				this.deps.save();
				this.applyToSession(key, value);
				this.active = this.buildModelStep(); // 与内置一致：完成后循环回模型列表
			},
			onCancel: () => {
				this.active = this.buildModelStep();
			},
		});
	}

	/** 当前模型立即生效；其他模型提示需重载/切换模型后生效 */
	private applyToSession(key: string, level: string): void {
		const current = this.deps.ctx.model;
		if (!current || modelKey(current) !== key) {
			this.deps.markDirty();
			this.deps.notifySaved();
			return;
		}
		const effective = (
			level === CLEAR_OVERRIDE_VALUE ? this.globalDefaultLevel() : level
		) as ThinkingLevelValue;
		this.deps.pi.setThinkingLevel(effective);
	}

	render(width: number): string[] {
		return this.active.render(width);
	}

	handleInput(data: string): void {
		this.active.handleInput(data);
	}

	invalidate(): void {
		this.active.invalidate();
	}
}

// —— theme 子菜单（单一主题 / 自动模式亮暗主题对，选择时实时预览）——

const AUTOMATIC_THEME_VALUE = "/";

type TerminalTheme = "light" | "dark";

interface ParsedAutoTheme {
	lightTheme: string;
	darkTheme: string;
}

/** 解析 "<亮色>/<暗色>" 自动主题设置（恰好一个 / 且两侧非空）；与内置 parseAutoThemeSetting 一致 */
function parseAutoThemeSetting(setting: string): ParsedAutoTheme | undefined {
	const slashIndex = setting.indexOf("/");
	if (slashIndex === -1 || setting.indexOf("/", slashIndex + 1) !== -1) return undefined;
	const lightTheme = setting.slice(0, slashIndex).trim();
	const darkTheme = setting.slice(slashIndex + 1).trim();
	if (!lightTheme || !darkTheme) return undefined;
	return { lightTheme, darkTheme };
}

/** 与内置 preferredTheme 一致：优先 preferred，其次 fallback，再其次列表首项 */
function preferredTheme(available: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && available.includes(preferred)) return preferred;
	if (available.includes(fallback)) return fallback;
	return available[0] ?? fallback;
}

/** 把 theme 设置解析为实际主题名；与内置 resolveThemeSetting 一致 */
function resolveThemeSetting(setting: string | undefined, terminalTheme: TerminalTheme): string | undefined {
	if (!setting) return undefined;
	const auto = parseAutoThemeSetting(setting);
	if (auto) return terminalTheme === "light" ? auto.lightTheme : auto.darkTheme;
	if (!setting.includes("/")) return setting;
	return undefined;
}

// 终端亮/暗检测：复刻 pi 的 detectTerminalBackgroundFromEnv（COLORFGBG 兜底，失败回退 dark；
// 无 OSC 查询能力，可能与 pi 的查询结果不同 —— 仅影响自动模式的「当前激活」显示）
const ANSI_BASIC_COLORS = [
	"#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
	"#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
];

function ansi256ToHex(index: number): string {
	if (index < 16) return ANSI_BASIC_COLORS[index];
	if (index < 232) {
		const cube = index - 16;
		const r = Math.floor(cube / 36);
		const g = Math.floor((cube % 36) / 6);
		const b = cube % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}
	const gray = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
	return `#${gray}${gray}${gray}`;
}

function rgbLuminance(r: number, g: number, b: number): number {
	const toLinear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function detectTerminalTheme(): TerminalTheme {
	const parts = (process.env.COLORFGBG ?? "").split(";");
	for (let i = parts.length - 1; i >= 0; i--) {
		const bg = parseInt(parts[i].trim(), 10);
		if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
			const hex = ansi256ToHex(bg).slice(1);
			const r = parseInt(hex.slice(0, 2), 16);
			const g = parseInt(hex.slice(2, 4), 16);
			const b = parseInt(hex.slice(4, 6), 16);
			return rgbLuminance(r, g, b) >= 0.5 ? "light" : "dark";
		}
	}
	return "dark";
}

class ThemeSubmenu extends Container {
	private active: Component & { handleInput?: (data: string) => void };
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;
	private readonly originalSetting: string;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;

	constructor(
		private readonly deps: PanelDeps,
		private readonly onClose: (selectedValue?: string) => void,
	) {
		super();
		const stored = getByPath(deps.settings, ["theme"]);
		const setting = typeof stored === "string" && stored.length > 0 ? stored : "dark"; // pi 默认 dark
		this.originalSetting = setting;
		this.availableThemes = deps.ctx.ui.getAllThemes().map((t) => t.name);
		this.terminalTheme = detectTerminalTheme();

		const auto = parseAutoThemeSetting(setting);
		this.mode = auto ? "automatic" : "single";
		// 与内置 defaultAutomaticThemes 一致：无自动设置时亮/暗都取当前单一主题
		const fixed = auto || setting.includes("/") ? undefined : setting;
		const defaultPair = auto ?? {
			lightTheme: preferredTheme(this.availableThemes, fixed, "dark"),
			darkTheme: preferredTheme(this.availableThemes, fixed, "dark"),
		};
		this.lightTheme = defaultPair.lightTheme;
		this.darkTheme = defaultPair.darkTheme;
		this.singleTheme = preferredTheme(
			this.availableThemes,
			auto ? this.activeAutomaticTheme() : fixed,
			"dark",
		);
		this.active = this.mode === "automatic" ? this.buildAutomaticMenu() : this.buildSingleMenu();
	}

	private activeAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	/** 当前模式对应的 theme 设置字符串 */
	private currentSetting(): string {
		return this.mode === "automatic" ? `${this.lightTheme}/${this.darkTheme}` : this.singleTheme;
	}

	/** 实时预览（setTheme 立即换肤，经全局主题代理所有组件即时变色） */
	private preview(setting: string): void {
		const name = resolveThemeSetting(setting, this.terminalTheme);
		if (name) this.deps.ctx.ui.setTheme(name);
	}

	/** 应用：写 settings.json + 立即生效，关闭子菜单并把设置字符串回显到主列表 */
	private apply(setting: string): void {
		setByPath(this.deps.settings, ["theme"], setting);
		this.deps.save();
		this.preview(setting);
		this.onClose(setting);
	}

	/** 取消：还原为打开面板时的主题 */
	private cancel(): void {
		const name = resolveThemeSetting(this.originalSetting, this.terminalTheme);
		if (name) this.deps.ctx.ui.setTheme(name);
		this.onClose();
	}

	private buildSingleMenu(): SelectStep {
		const items: SelectItem[] = [
			{
				value: AUTOMATIC_THEME_VALUE,
				label: "自动 (Automatic)",
				description: "根据终端亮/暗外观使用不同主题",
			},
			...this.availableThemes.map((name) => ({ value: name, label: name })),
		];
		return new SelectStep(this.deps.theme, {
			title: "主题",
			description: "选择主题，或选择「自动」跟随终端外观",
			items,
			preselect: this.singleTheme,
			onSelect: (value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.preview(this.currentSetting());
					this.active = this.buildAutomaticMenu();
					return;
				}
				this.singleTheme = value;
				this.apply(value);
			},
			onCancel: () => this.cancel(),
			onSelectionChange: (value) => {
				this.preview(value === AUTOMATIC_THEME_VALUE ? this.currentSetting() : value);
			},
		});
	}

	private buildAutomaticMenu(): Component & { handleInput?: (data: string) => void } {
		const container = new Container();
		const theme = this.deps.theme;
		container.addChild(new Text(theme.bold(theme.fg("accent", "自动主题")), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "为终端亮色/暗色外观分别选择主题。"), 0, 0));
		container.addChild(new Text(theme.fg("muted", "亮/暗检测依赖终端支持。"), 0, 0));
		container.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "亮色主题",
				description: "终端为亮色外观时使用的主题",
				currentValue: this.lightTheme,
				submenu: (_currentValue, done) =>
					this.createThemeSelect("亮色主题", "选择终端亮色外观时使用的主题", this.lightTheme, done, (value) => {
						this.lightTheme = value;
						this.preview(this.currentSetting());
						done(value);
					}),
			},
			{
				id: "dark-theme",
				label: "暗色主题",
				description: "终端为暗色外观时使用的主题",
				currentValue: this.darkTheme,
				submenu: (_currentValue, done) =>
					this.createThemeSelect("暗色主题", "选择终端暗色外观时使用的主题", this.darkTheme, done, (value) => {
						this.darkTheme = value;
						this.preview(this.currentSetting());
						done(value);
					}),
			},
			{
				id: "apply",
				label: "应用",
				description: "保存并返回",
				currentValue: "保存并返回",
				values: ["保存并返回"],
			},
			{
				id: "single-mode",
				label: "切换模式",
				description: "改为亮暗共用的单一主题",
				currentValue: "切换为单一主题",
				values: ["切换为单一主题"],
			},
		];

		const list = new SettingsList(
			items,
			4,
			getSettingsListTheme(),
			(id) => {
				if (id === "apply") {
					this.apply(this.currentSetting());
				} else if (id === "single-mode") {
					this.mode = "single";
					this.singleTheme = this.activeAutomaticTheme();
					this.preview(this.singleTheme);
					this.active = this.buildSingleMenu();
				}
			},
			() => this.cancel(),
		);
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => list.handleInput(data),
		};
	}

	/** 自动模式下的主题选择：选择时预览，Esc 放弃改动并还原预览 */
	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onApply: (value: string) => void,
	): SelectStep {
		return new SelectStep(this.deps.theme, {
			title,
			description,
			items: this.availableThemes.map((name) => ({ value: name, label: name })),
			preselect: currentValue,
			onSelect: (value) => onApply(value),
			onCancel: () => {
				this.preview(this.currentSetting());
				done();
			},
			onSelectionChange: (value) => this.preview(value),
		});
	}

	render(width: number): string[] {
		return this.active.render(width);
	}

	handleInput(data: string): void {
		this.active.handleInput?.(data);
	}

	invalidate(): void {
		this.active.invalidate?.();
	}
}

// —— 命令入口 ——

async function openSettingsPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const settingsPath = join(getAgentDir(), "settings.json");
	const loaded = loadSettings(settingsPath);
	if (loaded.corrupted) {
		ctx.ui.notify(`settings.json 已损坏，原文件已备份到 ${loaded.backupPath}，面板以默认值打开`, "warning");
	}
	const settings = loaded.settings;

	let dirty = false;
	const deps: PanelDeps = {
		ctx,
		pi,
		settings,
		theme: undefined as unknown as Theme, // custom() 工厂内赋值
		save: () => {
			try {
				saveSettings(settingsPath, settings);
			} catch (err) {
				ctx.ui.notify(`保存失败：${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
		markDirty: () => {
			dirty = true;
		},
		notifySaved: () => ctx.ui.notify("已保存，部分设置需重载后生效", "info"),
	};

	await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
		deps.theme = theme;
		const imagesSupported = getCapabilities().images !== null;
		const defs = visibleItems(imagesSupported);
		const items: SettingItem[] = defs.map((def) => buildSettingItem(def, deps));
		const container = new Container();
		// jiti 下必须显式传颜色函数（pi 文档）；border 与内置默认色一致
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		const list = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newDisplay) => onValueChange(id, newDisplay, deps),
			() => done(),
			{ enableSearch: true }, // 与内置 0.87.1 面板一致（顶部搜索框）
		);
		container.addChild(list);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => list.handleInput(data),
		};
	});

	if (dirty) {
		const yes = await ctx.ui.confirm("设置已保存", "部分设置需重载后生效。立即重载？");
		if (yes) {
			await ctx.reload();
			return; // reload 后不得再触碰旧状态
		}
	}
}

export default function (pi: ExtensionAPI) {
	// 快捷键表渲染器：把 appendEntry 持久化的 markdown 渲染进聊天记录（版式复刻内置 /hotkeys）。
	// 顶层注册一次即可（entryRenderers 为 Map 语义，/reload 后重复注册覆盖，天然幂等）。
	pi.registerEntryRenderer(HOTKEYS_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as HotkeysEntryData | undefined;
		if (!data || typeof data.markdown !== "string") return undefined; // 旧会话/坏数据容错
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		container.addChild(new Text(theme.bold(theme.fg("accent", "键盘快捷键")), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(data.markdown, 1, 1, getMarkdownTheme()));
		container.addChild(new DynamicBorder((s) => theme.fg("border", s)));
		return container;
	});

	// /快捷键：中文快捷键表（对齐内置 /hotkeys，Extensions 区无法枚举故省略，表末有提示行）
	pi.registerCommand("快捷键", {
		description: "显示全部键盘快捷键（中文版）",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/快捷键 仅支持 TUI 模式", "error");
				return;
			}
			// custom() 工厂注入 app 真实 KeybindingsManager（含用户 keybindings.json 覆盖）。
			// 同步 done() 安全：close 幂等且组件不再挂载（pi 0.84.3 showExtensionCustom），零闪烁。
			const kb = await ctx.ui.custom<KeybindingsManager>((_tui, _theme, keybindings, done) => {
				done(keybindings);
				return new Container();
			});
			const markdown = buildHotkeysMarkdown((id) => kb.getKeys(id as Keybinding));
			pi.appendEntry<HotkeysEntryData>(HOTKEYS_ENTRY_TYPE, { markdown });
		},
	});

	// 斜杠命令描述汉化：包装 autocomplete provider，仅替换 description，命令名不动。
	// session_start 在 startup/new/resume/fork/reload 均触发，/reload 后自动重新注册。
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider(wrapProvider);
	});

	const handler = async (_args: string, ctx: ExtensionCommandContext) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/设置 仅支持 TUI 模式", "error");
			return;
		}
		await openSettingsPanel(pi, ctx);
	};
	pi.registerCommand("设置", {
		description: "中文设置面板（与内置 /settings 对齐）",
		handler,
	});

	// 中文 footer（含 TPS 段）与 /tps 命令；要恢复默认 footer 删除本行后重启
	installFooterFeature(pi);

	// 中文启动页眉（收起=紧凑提示，ctrl+o 展开完整清单）；要恢复内置页眉删除本行后重启
	installHeaderFeature(pi);

	// bash 工具结果块汉化（同名覆盖内置 bash，execute 与内置同源，仅替换渲染槽位）
	// 要恢复内置英文渲染：删除本行后 /reload
	installBashZhFeature(pi);

	// write 工具调用块汉化（截断提示；同名覆盖内置 write，execute 与内置同源）
	// 要恢复内置英文渲染：删除本行后 /reload
	installWriteZhFeature(pi);

	// 全屏模式「回到底部」浮动提示汉化（补丁 TuiAltScreen 的 scrollToEndIndicator）
	// 要恢复内置英文：删除本行后重启 pi（原型补丁不随 /reload 卸载）
	installScrollIndicatorZhFeature(pi);

	// /mcp 管理器汉化（包装共享 ctx.ui 的 custom/notify/select/input，翻译内置 McpManagerView 菜单）
	// 要恢复内置英文：删除本行后 /reload
	installMcpZhFeature(pi);

	// /update-zh-for-pi：读取随附操作手册注入会话，由 agent 执行汉化审计与更新
	pi.registerCommand("update-zh-for-pi", {
		description: "更新汉化数据表以匹配当前 pi 版本（注入操作手册由 agent 执行）",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/update-zh-for-pi 仅支持 TUI 模式", "error");
				return;
			}
			const extDir = dirname(fileURLToPath(import.meta.url));
			let playbook: string;
			try {
				playbook = await readFile(join(extDir, "update-playbook.md"), "utf-8");
			} catch (err) {
				ctx.ui.notify(`读取 update-playbook.md 失败：${err instanceof Error ? err.message : String(err)}`, "error");
				return;
			}
			// pi.sendUserMessage 返回 void，始终触发一个回合
			pi.sendUserMessage(
				`请执行以下 zh-for-pi 汉化更新操作手册。扩展目录（手册中的 EXT）：${extDir}\n` +
					`严格按手册步骤执行，完成后按「第 7 步：验收清单」自检并汇报变更摘要。\n\n${playbook}`,
			);
		},
	});
}
