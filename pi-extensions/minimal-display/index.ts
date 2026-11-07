/**
 * minimal-display — WIRING ONLY. All behavior lives beside this entry point.
 *
 *   1. compact one-line tool rows showing `tool ×1`, with Pi's own expanded output on Ctrl+O;
 *   2. compact collapsed thinking rows showing `think ×1`;
 *   3. optional folding of adjacent rows into one summary line.
 *
 * NOTHING ON DISK IS PATCHED. Pi's bundled CLI hands extensions its own live
 * module namespaces (jiti `virtualModules`), so the component classes imported
 * here are the exact objects the running TUI instantiates, and `core-patch.ts`
 * wraps their prototypes at load time. See that file for the full rationale.
 *
 * This extension registers NO tools. Re-registering built-ins would change their
 * source ownership and make pi-subagents drop them from child tool allowlists.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as core from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
// SettingsList lives in pi-tui; its Pi-styled theme comes from pi-coding-agent.
// Using both means `/display` is the same component, with the same
// keybindings and colours, as Pi's own `/settings`.
import { SettingsList } from "@earendil-works/pi-tui";
import { installBridges, sharedState } from "./bridge.ts";
import { type Config, type EditableSettings } from "./config.ts";
import { customSeed, loadSettings, saveBasicSettings } from "./config-file.ts";
import { createConfigScreen } from "./config-ui.ts";
import { patchCore } from "./core-patch.ts";
import { refreshMcpTools } from "./tools.ts";

export default function (pi: ExtensionAPI) {
  // Adopted from the previous load when reloading: existing transcript rows close
  // over these and resolve appearance at render time, so replacing them would
  // strand every row on stale state.
  const { config, grouping } = sharedState(loadSettings());

  installBridges({ config, grouping });
  // Idempotent, so a /reload only refreshes the Bridge the wrappers read.
  patchCore(core);

  const refresh = () => {
    // MCP tool names depend on adapter configuration, so they are discovered from
    // public source metadata rather than a maintained whitelist.
    refreshMcpTools(pi.getAllTools());
    // Re-read settings.json so an external edit (or pi-env) applies without a
    // restart. Session overrides are re-applied by Config.replace().
    config.replace(loadSettings());
  };
  pi.on("session_start", refresh);
  pi.on("turn_start", refresh);
  pi.on("agent_start", () => grouping.agentStarted());
  pi.on("agent_settled", () => grouping.agentSettled());

  pi.registerCommand("display", {
    description: "打开 minimal-display 显示设置",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("用法：/display", "warning");
        return;
      }
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("/display 需要交互式 TUI。", "warning");
        return;
      }

      await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) =>
        createConfigScreen({
          SettingsList,
          theme: getSettingsListTheme(),
          config,
          onChange: (key, value) => persist(ctx, config, key, value),
          toolNames: () => pi.getAllTools().map((tool) => tool.name),
          onExcludeChange: (names) => persist(ctx, config, "excludeTools", names),
          onClose: () => done(),
        }),
      );
    },
  });
}

type NotifyContext = { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } };

export function persist<K extends keyof EditableSettings>(
  ctx: NotifyContext,
  config: Config,
  key: K,
  value: EditableSettings[K],
): void {
  // The first switch to `custom` starts from the `lite` look (see customSeed).
  const seed = key === "preset" && value === "custom" ? customSeed() : undefined;
  const changes: Partial<Record<keyof EditableSettings, unknown>> = { ...seed, [key]: value };
  const result = saveBasicSettings(changes as Partial<EditableSettings>);
  for (const [k, v] of Object.entries(changes) as [keyof EditableSettings, never][]) {
    config.set(k, v);
    // On success the file agrees, so it becomes the source of truth again.
    if (result.ok) config.clearSessionOverride(k);
    else config.setSessionOverride(k, v);
  }
  if (result.ok) return;
  if (result.reason === "comments") {
    ctx.ui.notify(
      `仅在当前会话生效。settings.json 含有注释，JSON.stringify 会删除这些注释；请手动修改 "minimalDisplay": { "${key}": ${JSON.stringify(value)} } 以持久保存。`,
      "warning",
    );
    return;
  }
  const reason = result.detail ? `${result.reason}: ${result.detail}` : result.reason;
  ctx.ui.notify(`仅在当前会话生效；settings.json 无法解析或写入（${reason}）。`, "warning");
}
