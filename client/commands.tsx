// Client panel UI. This file compiles only into the app bundle; no Node APIs here.
// Theme tokens are the Paseo 0.8 PluginTheme colors; this panel uses surface0,
// foreground, foregroundMuted, accent and statusDanger.
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import type { AppButton, ButtonConfig, ScriptButton } from "../shared/config";
import {
  loadConfigRpc,
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
} from "../shared/rpc";

type ButtonRunState =
  | { status: "idle" }
  | { status: "opening" }
  | { status: "starting" }
  | { status: "running"; jobId: string; startedAt: string; output: string[] }
  | { status: "finished"; ok: boolean; detail: string; output: string[] };

interface LoadedConfig {
  buttons: ButtonConfig[];
  source: string;
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

function formatElapsed(startedAtIso: string, now: number): string {
  const start = new Date(startedAtIso).getTime();
  if (Number.isNaN(start)) return "";
  const seconds = Math.max(0, Math.round((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function isScriptButton(button: ButtonConfig): button is ScriptButton {
  return button.type === "script";
}

function isAppButton(button: ButtonConfig): button is AppButton {
  return button.type === "app";
}

export function CommandsPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const workspace = useWorkspace(workspaceId, (w) => ({
    root: w.projectRootPath,
    directory: w.directory,
    name: w.name,
  }));
  const projectRoot = workspace?.root || workspace?.directory || "";

  const loadConfig = useRpc(loadConfigRpc);
  const openApp = useRpc(openAppRpc);
  const startScript = useRpc(runScriptStartRpc);
  const pollScript = useRpc(runScriptPollRpc);
  const stopScript = useRpc(runScriptStopRpc);

  const [config, setConfig] = useState<LoadedConfig | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [runStates, setRunStates] = useState<Record<string, ButtonRunState>>({});

  const runStatesRef = useRef(runStates);
  runStatesRef.current = runStates;

  // Load paseo.json whenever the project root (or manual reload) changes.
  useEffect(() => {
    if (!projectRoot) {
      setConfig({ buttons: [], source: "", error: "无法解析项目根目录" });
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
            error: `读取配置失败：${String(error)}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // loadConfig is a stable useCallback from useRpc; projectRoot + reloadTick drive reloads.
  }, [projectRoot, reloadTick]);

  // Poll every running script job.
  useEffect(() => {
    const timer = setInterval(() => {
      const running = Object.entries(runStatesRef.current).filter(
        (entry): entry is [string, Extract<ButtonRunState, { status: "running" }>] =>
          entry[1].status === "running",
      );
      if (running.length === 0) return;
      void Promise.all(
        running.map(async ([id, state]) => {
          try {
            const result = await pollScript({ jobId: state.jobId });
            setRunStates((prev) => {
              const current = prev[id];
              if (!current || current.status !== "running" || current.jobId !== state.jobId) {
                return prev;
              }
              if (result.status === "running") {
                return {
                  ...prev,
                  [id]: {
                    status: "running",
                    jobId: state.jobId,
                    startedAt: result.startedAt ?? current.startedAt,
                    output: result.output,
                  },
                };
              }
              const ok = result.status === "succeeded";
              const detail = ok
                ? `完成 · 用时 ${formatElapsed(result.startedAt ?? current.startedAt, Date.now())}`
                : `失败 · 退出码 ${result.exitCode ?? "被终止"}`;
              return { ...prev, [id]: { status: "finished", ok, detail, output: result.output } };
            });
          } catch {
            // Transient RPC failure; keep polling on the next tick.
          }
        }),
      );
    }, 700);
    return () => clearInterval(timer);
  }, [pollScript]);

  async function handleRunApp(button: AppButton) {
    setRunStates((prev) => ({ ...prev, [button.id]: { status: "opening" } }));
    try {
      const result = await openApp({ app: button.app, bundleId: button.bundleId ?? null });
      setRunStates((prev) => ({
        ...prev,
        [button.id]: { status: "finished", ok: result.ok, detail: result.message, output: [] },
      }));
    } catch (error) {
      setRunStates((prev) => ({
        ...prev,
        [button.id]: { status: "finished", ok: false, detail: String(error), output: [] },
      }));
    }
  }

  async function handleStartScript(button: ScriptButton) {
    setRunStates((prev) => ({ ...prev, [button.id]: { status: "starting" } }));
    try {
      const result = await startScript({
        jobId: button.id,
        command: button.command,
        projectRoot,
        cwd: button.cwd ?? "",
      });
      if (!result.ok) {
        setRunStates((prev) => ({
          ...prev,
          [button.id]: { status: "finished", ok: false, detail: result.error ?? "启动失败", output: [] },
        }));
        return;
      }
      setRunStates((prev) => ({
        ...prev,
        [button.id]: { status: "running", jobId: button.id, startedAt: new Date().toISOString(), output: [] },
      }));
    } catch (error) {
      setRunStates((prev) => ({
        ...prev,
        [button.id]: { status: "finished", ok: false, detail: String(error), output: [] },
      }));
    }
  }

  async function handleStopScript(button: ScriptButton) {
    const state = runStatesRef.current[button.id];
    if (!state) return;
    if (state.status === "starting") {
      setRunStates((prev) => ({
        ...prev,
        [button.id]: { status: "finished", ok: false, detail: "已取消", output: [] },
      }));
      return;
    }
    if (state.status !== "running") return;
    try {
      await stopScript({ jobId: state.jobId });
    } catch {
      // Ignore stop failures; the next poll will settle the state.
    }
    setRunStates((prev) => {
      const current = prev[button.id];
      return {
        ...prev,
        [button.id]: {
          status: "finished",
          ok: false,
          detail: "已停止",
          output: current && current.status === "running" ? current.output : [],
        },
      };
    });
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
        backgroundColor: theme.colors.foregroundMuted,
        opacity: 0.25,
        marginVertical: compact ? 8 : 10,
      },
      card: {
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
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
      okText: { color: theme.colors.accent, fontSize: 13, fontWeight: "600" as const },
      errText: { color: theme.colors.statusDanger, fontSize: 13, fontWeight: "600" as const },
      output: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        marginTop: 4,
        opacity: 0.9,
      },
      reloadBtn: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        alignSelf: "flex-start" as const,
      },
      emptyCard: {
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 10,
        padding: compact ? 12 : 16,
        gap: 8,
      },
      sample: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        opacity: 0.9,
        lineHeight: 18,
      },
    };
  }, [theme, layout.compact]);

  const buttons = config?.buttons ?? [];
  const now = Date.now();

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
          <Pressable
            accessibilityRole="button"
            onPress={() => setReloadTick((tick) => tick + 1)}
            style={styles.reloadBtn}
          >
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
            const state = runStates[button.id] ?? { status: "idle" };
            if (isAppButton(button)) {
              return (
                <Pressable
                  key={button.id}
                  accessibilityRole="button"
                  disabled={state.status === "opening"}
                  onPress={() => void handleRunApp(button)}
                  style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
                >
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>{button.label}</Text>
                      <Text style={styles.labelMuted}>打开应用 · {button.app}</Text>
                    </View>
                    {state.status === "opening" ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : state.status === "finished" ? (
                      <Text style={state.ok ? styles.okText : styles.errText}>
                        {state.ok ? "✓" : "✕"}
                      </Text>
                    ) : null}
                  </View>
                  {state.status === "finished" ? (
                    <Text style={state.ok ? styles.okText : styles.errText}>{state.detail}</Text>
                  ) : null}
                </Pressable>
              );
            }

            // Script button
            const running = state.status === "running";
            const starting = state.status === "starting";
            const outputTail = state.status === "running" || state.status === "finished"
              ? state.output.slice(-3)
              : [];
            return (
              <View key={button.id} style={styles.card}>
                <Pressable
                  accessibilityRole="button"
                  disabled={running || starting}
                  onPress={() => void handleStartScript(button)}
                >
                  <View style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>{button.label}</Text>
                      <Text style={styles.labelMuted}>
                        {button.description ?? button.command}
                      </Text>
                    </View>
                    {starting ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : running ? (
                      <Text style={styles.statusText}>
                        {formatElapsed(state.startedAt, now)} 运行中
                      </Text>
                    ) : state.status === "finished" ? (
                      <Text style={state.ok ? styles.okText : styles.errText}>
                        {state.ok ? "✓" : "✕"}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>

                {running ? (
                  <View style={[styles.row, { justifyContent: "space-between" }]}>
                    <Text style={[styles.statusText, { flexShrink: 1 }]} numberOfLines={1}>
                      {state.output.slice(-1)[0] ?? "执行中…"}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => void handleStopScript(button)}
                      style={{ paddingHorizontal: 10, paddingVertical: 4 }}
                    >
                      <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>停止</Text>
                    </Pressable>
                  </View>
                ) : null}

                {state.status === "finished" ? (
                  <>
                    <Text style={state.ok ? styles.okText : styles.errText}>{state.detail}</Text>
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
