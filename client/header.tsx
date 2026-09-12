// The workspace header button: a menu of the project's paseo.json buttons, plus
// coding-plan usage, run status, the full panel, and a config reload.
//
// Registered once per workspace by index.client.tsx (Paseo binds a header button
// to a single workspace). The icon carries a small accent dot while any script of
// that workspace is running, so the header shows activity without opening anything.
import type {
  PluginButton,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { View } from "react-native";
import { DEFAULT_USAGE_REFRESH_MINUTES, type ButtonConfig } from "../shared/config";
import { runStore, useWorkspaceRuns } from "./run-store";
import { StatusPopover } from "./status-popover";
import { usageSummaryLine } from "./usage-format";
import { usageStore } from "./usage-store";

/** Workspace panel id registered by the client entry; the menu opens it by id. */
export const COMMANDS_PANEL_ID = "commands";
/** Plugin-local button id. Paseo scopes it per workspace, so it repeats safely. */
export const HEADER_BUTTON_ID = "commands";

function CommandsIcon({ workspaceId, size, color, theme }: PluginButtonIconProps) {
  const runs = useWorkspaceRuns(workspaceId);
  const dot = Math.max(6, Math.round(size * 0.34));
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Icon name="SquareTerminal" size={size} color={color} />
      {runs.running > 0 ? (
        <View
          style={{
            position: "absolute",
            top: -1,
            right: -1,
            width: dot,
            height: dot,
            borderRadius: dot / 2,
            backgroundColor: theme.colors.accent,
          }}
        />
      ) : null}
    </View>
  );
}

function hintItem(id: string, title: string, icon: string): PluginButtonMenuEntry {
  return {
    kind: "item",
    id,
    title,
    icon,
    disabled: true,
    behavior: { kind: "action", onPress() {} },
  };
}

export interface HeaderMenuInput {
  client: PluginClientContext;
  workspaceId: string;
  projectRoot: string;
  /** The loaded paseo.json. */
  config: { buttons: readonly ButtonConfig[]; error: string | null };
  /** Re-read paseo.json and rebuild this button. */
  onReload: () => void;
}

/**
 * Menu ids come from the config index, not from user-authored button ids: Paseo
 * validates menu ids against `^[a-z][a-z0-9-]*$` and throws when one is invalid,
 * which would take the whole button down.
 */
export function createHeaderMenu({
  client,
  workspaceId,
  projectRoot,
  config,
  onReload,
}: HeaderMenuInput): PluginButton {
  const items: PluginButtonMenuEntry[] = [];

  if (config.error) {
    items.push(hintItem("config-error", "paseo.json 配置无效", "TriangleAlert"));
  } else if (config.buttons.length === 0) {
    items.push(hintItem("config-empty", "paseo.json 里还没有配置按钮", "CircleSlash"));
  } else {
    config.buttons.forEach((button, index) => {
      if (button.type === "usage") {
        // Read-only glance row: live summary, refreshed by the usage store.
        // Keyed by card index, since one Config button can expand per account.
        const entry = usageStore.view(workspaceId, String(index));
        const summary = entry.loading
          ? "获取中…"
          : entry.error
            ? `失败：${entry.error}`
            : usageSummaryLine(entry.result);
        // Several cards share one label, so name the account and mark the one pi
        // currently authenticates with.
        const account = entry.result?.account ?? button.accountSlot ?? null;
        const marker = entry.result?.isDefault
          ? `当前账号${entry.result.defaultAccount ? `（${entry.result.defaultAccount}）` : ""} · `
          : "";
        items.push(
          hintItem(
            `usage-${index}`,
            `${button.label}${account ? ` · ${account}` : ""} · ${marker}${summary}`,
            "Gauge",
          ),
        );
        return;
      }
      items.push({
        kind: "item",
        id: `run-${index}`,
        title: button.label,
        icon: button.type === "app" ? "AppWindow" : "Play",
        behavior: {
          kind: "action",
          // Returning the promise lets Paseo show busy state and surface failures.
          onPress: () =>
            button.type === "app"
              ? runStore.runApp(workspaceId, projectRoot, button)
              : runStore.startScript(workspaceId, projectRoot, button),
        },
      });
    });
  }

  const usageCount = config.buttons.filter((button) => button.type === "usage").length;
  if (usageCount > 0) {
    items.push({ kind: "separator", id: "sep-usage" });
    items.push({
      kind: "item",
      id: "refresh-usage",
      title: "刷新用量",
      icon: "Gauge",
      behavior: {
        kind: "action",
        onPress: () => usageStore.fetchWorkspace(workspaceId, 0),
      },
    });
  }

  items.push({ kind: "separator", id: "sep-status" });
  items.push({
    kind: "item",
    id: "run-status",
    title: "运行状态…",
    icon: "Activity",
    behavior: { kind: "popover", Content: StatusPopover },
  });
  items.push({
    kind: "item",
    id: "open-panel",
    title: "打开 Commands 面板",
    icon: "PanelRight",
    behavior: {
      kind: "action",
      onPress: () => client.openPanel(COMMANDS_PANEL_ID, { workspaceId }),
    },
  });
  items.push({ kind: "separator", id: "sep-reload" });
  items.push({
    kind: "item",
    id: "reload-config",
    title: "重新加载 paseo.json",
    icon: "RefreshCw",
    behavior: { kind: "action", onPress: onReload },
  });

  return {
    // Icon-only in the header; the tooltip and accessible label come from `title`.
    title: "项目命令",
    icon: CommandsIcon,
    behavior: { kind: "menu", items },
  };
}
