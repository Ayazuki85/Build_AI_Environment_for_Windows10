/**
 * /tps 交互式设置菜单。
 * 合并自 pi-token-speed 的 commands / options。
 */

import { getSettingsListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import {
	tpsSettings,
	type CountStrategy,
	type DisplayMode,
	type EndTpsBehavior,
	type TokenSpeedConfig,
} from "./tps-config";
import type { TokenSpeedEngine } from "./tps-engine";

/** 配置值的中文显示标签 */
const DISPLAY_LABELS: Record<DisplayMode, string> = {
	tps: "TPS 速度",
	ttft: "仅 TTFT",
	stats: "Token 统计",
	full: "完整详情",
};

const COUNT_STRATEGY_LABELS: Record<CountStrategy, string> = {
	estimate: "估算（快速）",
	direct: "直接计数（精确）",
};

const END_TPS_BEHAVIOR_LABELS: Record<EndTpsBehavior, string> = {
	average: "平均值（整体）",
	last: "最后值（滑动窗口）",
};

const TOGGLE_LABELS: Record<"on" | "off", string> = {
	on: "开启",
	off: "关闭",
};

/** 由显示标签反查配置键 */
function labelToKey<T extends string>(labels: Record<T, string>, label: string): T | undefined {
	const entry = Object.entries(labels).find(([, value]) => value === label);
	return entry?.[0] as T | undefined;
}

enum Options {
	DISPLAY = "display",
	USE_PROVIDER_TOKENS = "useProviderTokens",
	COUNT_STRATEGY = "countStrategy",
	END_TPS_BEHAVIOR = "endTpsBehavior",
}

export class TpsCommand {
	/**
	 * @param engine TPS 引擎（配置变更后需要重新 initialize）
	 * @param refresh 配置变更后请求界面重绘
	 */
	constructor(
		private readonly engine: TokenSpeedEngine,
		private readonly refresh: () => void,
	) {}

	/** 处理 /tps 命令 —— 打开设置菜单 */
	async run(ctx: ExtensionCommandContext): Promise<void> {
		const items = this.buildSettingsItems(tpsSettings.getConfig());

		await ctx.ui.custom<void>((_tui, _theme, _kb, done) =>
			this.createSettingsList(
				items,
				async (id, newValue) => this.handleSettingChange(id, newValue),
				done,
			),
		);
	}

	private async handleSettingChange(id: string, newValue: string): Promise<void> {
		if (id === Options.DISPLAY) {
			const key = labelToKey(DISPLAY_LABELS, newValue);
			if (key) await tpsSettings.setConfig({ display: key });
		} else if (id === Options.USE_PROVIDER_TOKENS) {
			await tpsSettings.setConfig({ useProviderTokens: newValue === TOGGLE_LABELS.on });
		} else if (id === Options.COUNT_STRATEGY) {
			const key = labelToKey(COUNT_STRATEGY_LABELS, newValue);
			if (key) await tpsSettings.setConfig({ countStrategy: key });
		} else if (id === Options.END_TPS_BEHAVIOR) {
			const key = labelToKey(END_TPS_BEHAVIOR_LABELS, newValue);
			if (key) await tpsSettings.setConfig({ endTpsBehavior: key });
		}

		// 用最新配置重新初始化引擎并重绘 footer
		this.engine.initialize();
		this.refresh();
	}

	private createSettingsList(
		items: SettingItem[],
		onChange: (id: string, newValue: string) => void,
		onClose: () => void,
	): SettingsList {
		return new SettingsList(items, items.length, getSettingsListTheme(), onChange, onClose);
	}

	private buildSettingsItems(config: TokenSpeedConfig): SettingItem[] {
		return [
			{
				id: Options.DISPLAY,
				label: "显示模式",
				description: "footer 中 TPS 段显示的信息详细程度",
				currentValue: DISPLAY_LABELS[config.display],
				values: Object.values(DISPLAY_LABELS),
			},
			{
				id: Options.USE_PROVIDER_TOKENS,
				label: "使用服务商 Token 计数",
				description: "使用服务商返回的 token 计数，而非本扩展的本地计数器",
				currentValue: config.useProviderTokens ? TOGGLE_LABELS.on : TOGGLE_LABELS.off,
				values: Object.values(TOGGLE_LABELS),
			},
			{
				id: Options.COUNT_STRATEGY,
				label: "计数策略",
				description: "直接计数（服务器流式输出 token）或估算计数（服务器流式输出文本块）",
				currentValue: COUNT_STRATEGY_LABELS[config.countStrategy],
				values: Object.values(COUNT_STRATEGY_LABELS),
			},
			{
				id: Options.END_TPS_BEHAVIOR,
				label: "流结束后的 TPS",
				description: "流式输出结束后显示整体平均值，还是最后一个滑动窗口的值",
				currentValue: END_TPS_BEHAVIOR_LABELS[config.endTpsBehavior],
				values: Object.values(END_TPS_BEHAVIOR_LABELS),
			},
		];
	}
}
