// Client panel UI. This file compiles only into the app bundle; no Node APIs here.
// Run state lives in ./run-store so the header button, its popover and this panel
// always agree.
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import type { AppButton, ButtonConfig, ScriptButton } from "../shared/config";
import { loadConfigRpc } from "../shared/rpc";
import { elapsedLabel } from "./format";
import { refreshWorkspaceMenu } from "./refresh-bus";
import { runStore, useWorkspaceRuns } from "./run-store";

interface LoadedConfig {
  buttons: ButtonConfig[];
  source: string;
  exists: boolean;
  error: string | null;
}

const SAMPLE_CONFIG = `{
  "buttons": [
    { "type": "app", "id": "godot", "label": "Godot", "app": "Godot" },
    {
      "type": "script",
      "id": "export",
      "label": "导出 Web",
      "command": "godot --headless --export-release \\"Web\\""
    }
  ]
}`;

function isAppButton(button: ButtonConfig): button is AppButton {
  return button.type === "app";
}

export function CommandsPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (w) => ({
    root: w.projectRootPath,
    name: w.name,
  }));
  const projectRoot = workspace?.root ?? "";
  const runs = useWorkspaceRuns(workspaceId);

  const loadConfig = useRpc(loadConfigRpc);

  const [config, setConfig] = useState<LoadedConfig | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Load paseo.json whenever the project root (or manual reload) changes.
  useEffect(() => {
    if (!projectRoot) {
      setConfig({ buttons: [], source: "", exists: false, error: "无法解析项目根目录" });
      return;
    }
    let cancelled = false;
    setConfig(null);
    loadConfig({ projectRoot })
      .then((result) => {
        if (!cancelled) setConfig(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setConfig({
            buttons: [],
            source: `${projectRoot}/paseo.json`,
            exists: true,
            error: `读取配置失败：${String(error)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // loadConfig is a stable useCallback from useRpc; projectRoot + reloadTick drive reloads.
  }, [projectRoot, reloadTick]);

  function reload() {
    // Keep the header button's menu in sync with the panel.
    refreshWorkspaceMenu(workspaceId);
    setReloadTick((tick) => tick + 1);
  }

  const styles = useMemo(() => {
    const compact = layout.compact;
    return {
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 12 : 20, gap: compact ? 10 : 14 },
      headerTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 18 : 22,
        fontWeight: "600" as const,
      },
      headerSub: { color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 4 },
      divider: {
        height: 1,
        backgroundColor: theme.colors.border,
        marginVertical: compact ? 8 : 10,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 12 : 14,
        gap: 8,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
      },
      label: { color: theme.colors.foreground, fontSize: compact ? 15 : 16, fontWeight: "500" as const },
      labelMuted: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
      statusText: { color: theme.colors.foregroundMuted, fontSize: 13 },
      okText: { color: theme.colors.statusSuccess, fontSize: 13, fontWeight: "600" as const },
      errText: { color: theme.colors.statusDanger, fontSize: 13, fontWeight: "600" as const },
      output: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        marginTop: 4,
        lineHeight: 17,
      },
      reloadBtn: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        alignSelf: "flex-start" as const,
      },
      emptyCard: {
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 12 : 16,
        gap: 8,
      },
      sample: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 18,
      },
    };
  }, [theme, layout.compact]);

  const buttons = config?.buttons ?? [];

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>{workspace?.name ?? "项目命令"}</Text>
            <Text style={styles.headerSub}>
              按钮配置：项目根目录下的 paseo.json{config?.source ? `（${config.source}）` : ""}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={reload} style={styles.reloadBtn}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>重新加载</Text>
          </Pressable>
        </View>

        <View style={styles.divider} />

        {!config ? (
          <View style={styles.emptyCard}>
            <Text style={styles.statusText}>正在读取 paseo.json…</Text>
          </View>
        ) : config.error ? (
          <View style={styles.emptyCard}>
            <Text style={styles.errText}>{config.error}</Text>
            <Text style={styles.labelMuted}>示例 paseo.json：</Text>
            <Text style={styles.sample}>{SAMPLE_CONFIG}</Text>
          </View>
        ) : buttons.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.statusText}>paseo.json 里还没有配置按钮。</Text>
            <Text style={styles.labelMuted}>示例：</Text>
            <Text style={styles.sample}>{SAMPLE_CONFIG}</Text>
          </View>
        ) : (
          buttons.map((button) => {
            if (isAppButton(button)) {
              const app = runs.apps[button.id];
              return (
                <Pressable
                  key={button.id}
                  accessibilityRole="button"
                  disabled={app?.pending ?? false}
                  onPress={() => void runStore.runApp(workspaceId, button)}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
                >
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>{button.label}</Text>
                      <Text style={styles.labelMuted}>打开应用 · {button.app}</Text>
                    </View>
                    {app?.pending ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : app ? (
                      <Text style={app.ok ? styles.okText : styles.errText}>{app.ok ? "✓" : "✕"}</Text>
                    ) : null}
                  </View>
                  {app && !app.pending ? (
                    <Text style={app.ok ? styles.okText : styles.errText}>{app.detail}</Text>
                  ) : null}
                </Pressable>
              );
            }

            // Script button
            const job = runs.jobs.find((entry) => entry.buttonId === button.id);
            const runningJob = job && job.status === "running" ? job : null;
            const outputTail = job && job.output.length > 0 ? job.output.slice(-3) : [];
            const statusLabel = !job
              ? null
              : runningJob
                ? `${elapsedLabel(job.startedAt, null)} 运行中`
                : job.status === "stopped"
                  ? "已停止"
                  : job.status === "succeeded"
                    ? `完成 · 用时 ${elapsedLabel(job.startedAt, job.finishedAt)}`
                    : `失败 · 退出码 ${job.exitCode ?? "被终止"}`;

            return (
              <View key={button.id} style={styles.card}>
                <Pressable
                  accessibilityRole="button"
                  disabled={runningJob !== null}
                  onPress={() => void runStore.startScript(workspaceId, projectRoot, button)}
                >
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>{button.label}</Text>
                      <Text style={styles.labelMuted}>{button.description ?? button.command}</Text>
                    </View>
                    {runningJob ? (
                      <Text style={styles.statusText}>{statusLabel}</Text>
                    ) : job ? (
                      <Text style={job.status === "succeeded" ? styles.okText : styles.errText}>
                        {job.status === "succeeded" ? "✓" : "✕"}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>

                {runningJob ? (
                  <View style={[styles.row, { justifyContent: "space-between" }]}>
                    <Text style={[styles.statusText, { flexShrink: 1 }]} numberOfLines={1}>
                      {runningJob.output.slice(-1)[0] ?? "执行中…"}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void runStore.stopScript(workspaceId, runningJob.jobId)}
                      style={{ paddingHorizontal: 10, paddingVertical: 4 }}
                    >
                      <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>停止</Text>
                    </Pressable>
                  </View>
                ) : null}

                {job && !runningJob ? (
                  <>
                    <Text style={job.status === "succeeded" ? styles.okText : styles.errText}>
                      {statusLabel}
                    </Text>
                    {outputTail.length > 0 ? (
                      <Text style={styles.output} numberOfLines={3}>
                        {outputTail.join("\n")}
                      </Text>
                    ) : null}
                  </>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
