/** `/display` — Pi's SettingsList with live, conditional rows. */

import { truncateToWidth, type Component, type SettingItem, type SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";
import {
  BASIC_KEYS,
  LOOK_KEYS,
  PRESET_NAMES,
  isPreset,
  type ActivitySummary,
  type BasicKey,
  type BasicSettings,
  type Config,
  type GlyphStyle,
  type Preset,
  type Settings,
} from "./config.ts";

type Field = {
  key: BasicKey;
  label: string;
  description: string;
  activityOption?: boolean;
};

export const FIELDS: Field[] = [
  {
    key: "preset",
    label: "预设",
    description: "原生使用 Pi 默认显示；轻量使用工具计数行；完整增加工具合并和紧凑思考行；最强再折叠早先的活动；自定义使用你自己的值。预设只覆盖四个外观项，其余设置保持不变。",
  },
  {
    key: "compactToolRows",
    label: "紧凑工具行",
    description: "将每次工具调用显示为一行“工具名 ×1”，而不是 Pi 的完整卡片。按 Ctrl+O 查看完整调用和结果；关闭后恢复 Pi 的原生渲染。",
  },
  {
    key: "groupToolRuns",
    label: "合并连续工具调用",
    description: "将连续完成的工具调用合并为一条计数摘要，例如“read ×2, edit ×1”。",
  },
  {
    key: "foldIntermediateActivity",
    label: "折叠早先的活动",
    description: "保留最新的助手回复；将之前的文本、思考和工具调用折叠为一条摘要。",
  },
  {
    key: "activitySummary",
    label: "活动摘要",
    description: "选择折叠活动的替代内容：显示实际耗时，或显示用过的工具计数。",
    activityOption: true,
  },
  {
    key: "gutter",
    label: "左侧竖线",
    description: "在每一行左侧显示彩色竖线，让工具调用更容易辨认。",
  },
  {
    key: "timer",
    label: "耗时计时器",
    description: "显示运行中工具已经耗费的时长，并每秒更新一次。",
  },
  {
    key: "thinkingAsToolCall",
    label: "紧凑思考行",
    description: "将折叠的思考显示为一行“think ×1”。按 Ctrl+T 查看完整思考；关闭后恢复 Pi 的原生思考渲染。",
  },
  {
    key: "keepActiveToolsExpanded",
    label: "运行中的工具不参与合并",
    description: "不合并仍在运行的工具，让它保持可见（显示工具名 ×1 和计时）。",
  },
  {
    key: "keepActiveThinkingExpanded",
    label: "生成时显示完整思考",
    description: "生成思考时显示完整内容，而不是 think ×1 计数行。",
  },
  {
    key: "glyphStyle",
    label: "符号样式",
    description: "使用普通 Unicode 符号；如果符号缺失或对齐异常，可切换为 ASCII。无需 Nerd Font。",
  },
];

type InputComponent = Component & { handleInput(data: string): void };
type SettingsListConstructor = new (...args: ConstructorParameters<typeof SettingsList>) => SettingsList;
type BasicValue = BasicSettings[BasicKey];

const PRESET_LABELS: Record<Preset, string> = {
  off: "原生",
  lite: "轻量",
  full: "完整",
  max: "最强",
  custom: "自定义（可编辑）",
};
const ACTIVITY_LABELS: Record<ActivitySummary, string> = { elapsed: "耗时", tools: "工具计数" };
const GLYPH_LABELS: Record<GlyphStyle, string> = { unicode: "Unicode", ascii: "ASCII" };

function keyForLabel<T extends string>(labels: Record<T, string>, text: string): T | undefined {
  return (Object.keys(labels) as T[]).find((key) => labels[key] === text);
}

/** Chinese is display-only; unknown runtime values remain visible instead of being coerced. */
export function displayValue(value: BasicValue): string {
  if (isPreset(value)) return PRESET_LABELS[value];
  if (value === "elapsed" || value === "tools") return ACTIVITY_LABELS[value];
  if (value === "unicode" || value === "ascii") return GLYPH_LABELS[value];
  if (typeof value === "boolean") return value ? "开启" : "关闭";
  return String(value);
}

/** Return undefined for illegal labels so no caller can silently write a fallback value. */
export function parseDisplayValue<K extends BasicKey>(key: K, text: string): BasicSettings[K] | undefined {
  let value: BasicValue | undefined;
  switch (key) {
    case "preset":
      value = keyForLabel(PRESET_LABELS, text);
      break;
    case "activitySummary":
      value = keyForLabel(ACTIVITY_LABELS, text);
      break;
    case "glyphStyle":
      value = keyForLabel(GLYPH_LABELS, text);
      break;
    default:
      value = text === "开启" ? true : text === "关闭" ? false : undefined;
  }
  return value as BasicSettings[K] | undefined;
}

const CHOICES: Partial<Record<BasicKey, string[]>> = {
  preset: PRESET_NAMES.map((preset) => PRESET_LABELS[preset]),
  activitySummary: ["耗时", "工具计数"],
  glyphStyle: ["Unicode", "ASCII"],
};

const isLook = (key: string) => (LOOK_KEYS as readonly string[]).includes(key);

export function items(settings: Settings, dim?: (text: string) => string): SettingItem[] {
  return FIELDS.filter((field) => !field.activityOption || settings.foldIntermediateActivity).map(
    ({ key, label, description }) => {
      const value = displayValue(settings[key]);
      if (dim && isLook(key)) {
        const shown = dim(value);
        const hint = `当前值由“${displayValue(settings.preset)}”预设提供。将“预设”切换为“自定义（可编辑）”后即可修改；你自己的设置值会保留。`;
        return { id: key, label: dim(label), description: hint, currentValue: shown, values: [shown] };
      }
      return { id: key, label, description, currentValue: value, values: CHOICES[key] ?? ["开启", "关闭"] };
    },
  );
}

export type ConfigScreenDeps = {
  SettingsList: SettingsListConstructor;
  theme: SettingsListTheme;
  config: Config;
  onChange: (key: BasicKey, value: BasicValue) => void;
  toolNames: () => string[];
  onExcludeChange: (names: string[]) => void;
  onClose: () => void;
};

const EXCLUDE_ID = "excludeTools";
const PICKER_ROWS = 12;

export function excludedSummary(names: string[]): string {
  if (names.length === 0) return "无";
  return names.length <= 2 ? names.join(", ") : `${names.length} 个工具`;
}

function toolPicker(deps: ConfigScreenDeps, done: (summary: string) => void): Component {
  const { SettingsList, theme, config, toolNames, onExcludeChange } = deps;
  let excluded = [...config.get("excludeTools")];
  const known = new Set(toolNames());
  const names = [...new Set([...known, ...excluded])].sort((a, b) => a.localeCompare(b));
  const rows: SettingItem[] = names.map((name) => ({
    id: name,
    label: name,
    description: known.has(name) ? undefined : "本会话未加载此工具；它仍会保留在你的设置中。",
    currentValue: excluded.includes(name) ? "排除" : "紧凑",
    values: ["紧凑", "排除"],
  }));
  return new SettingsList(
    rows,
    Math.min(PICKER_ROWS, Math.max(rows.length, 1)),
    theme,
    (name, value) => {
      if (value !== "紧凑" && value !== "排除") return;
      excluded = value === "排除"
        ? [...new Set([...excluded, name])]
        : excluded.filter((excludedName) => excludedName !== name);
      onExcludeChange([...excluded]);
    },
    () => done(excludedSummary(excluded)),
    { enableSearch: true },
  );
}

export function createConfigScreen(deps: ConfigScreenDeps): InputComponent {
  const { SettingsList, theme, config, onChange, onClose } = deps;
  let list: SettingsList;
  let locked = false;

  const build = () => {
    const preset = config.all().preset;
    locked = preset !== "custom";
    const rows = [
      ...items(config.all(), locked ? theme.hint : undefined),
      {
        id: EXCLUDE_ID,
        label: "排除的工具",
        description: "使用工具自己的卡片而不是工具名 ×1 的紧凑行来显示，例如 subagent。按 Enter 选择；输入文字可搜索。",
        currentValue: excludedSummary(config.get("excludeTools")),
        submenu: (_current: string, done: (selected?: string) => void) => toolPicker(deps, done),
      },
    ];
    return new SettingsList(
      rows,
      rows.length,
      theme,
      (id, shown) => {
        if (!isBasicKey(id)) return;
        if (locked && isLook(id)) return;
        const value = parseDisplayValue(id, shown);
        if (value === undefined) return;
        config.set(id, value);
        onChange(id, value);
        if (id === "preset" || id === "foldIntermediateActivity") {
          list = build();
          list.selectItem(id);
        }
      },
      onClose,
    );
  };

  list = build();
  return {
    render: (width) => [
      ...list.render(width),
      truncateToWidth(theme.hint("  更改实时生效 · Ctrl+O 查看工具输出"), width),
    ],
    handleInput: (data) => list.handleInput(data),
    handleMouse: (event) => list.handleMouse?.(event),
    invalidate: () => list.invalidate?.(),
  };
}

function isBasicKey(id: string): id is BasicKey {
  return (BASIC_KEYS as string[]).includes(id);
}
