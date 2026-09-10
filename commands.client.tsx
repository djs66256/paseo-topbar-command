// Client panel UI. This file compiles only into the app bundle; no Node APIs here.
// Theme tokens available in Paseo 0.7: surface0, foreground, foregroundMuted,
// accent, accentForeground, statusDanger. Use only those.
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc, useWorkspace } from "@getpaseo/plugin";
import type { AppButton, ButtonConfig, ScriptButton } from "./config.shared";
import {
  loadConfigRpc,
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
} from "./rpc.shared";

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
    {
      "type": "app",
      "id": "godot",
      "label": "Godot",
      "app": "Godot",
      "projectPath": "."
    },
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

/** Human-readable status shown in a button's expanded details. */
function describeAppState(state: ButtonRunState, now: number): string {
  switch (state.status) {
    case "idle":
      return "未打开";
    case "opening":
      return "打开中…";
    case "starting":
      return "启动中…";
    case "running":
      return `运行中 · ${formatElapsed(state.startedAt, now)}`;
    case "finished":
      return state.ok ? "已打开" : "打开失败";
    default:
      return "未知";
  }
}

/** Human-readable status shown in a script button's expanded details. */
function describeScriptState(state: ButtonRunState, now: number): string {
  switch (state.status) {
    case "idle":
      return "未运行";
    case "opening":
      return "打开中…";
    case "starting":
      return "启动中…";
    case "running":
      return `运行中 · 已运行 ${formatElapsed(state.startedAt, now)}`;
    case "finished":
      return state.ok ? "执行成功" : "执行失败";
    default:
      return "未知";
  }
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
  // Which button cards are expanded to show full status + output details.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function toggleExpanded(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

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
      const result = await openApp({
        app: button.app,
        bundleId: button.bundleId ?? null,
        projectRoot,
        projectPath: button.projectPath ?? "",
        args: button.args ?? [],
      });
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
      chevronBtn: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
      },
      chevron: { color: theme.colors.foregroundMuted, fontSize: 14 },
      details: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.foregroundMuted,
        marginTop: 2,
        paddingTop: 8,
        gap: 6,
      },
      detailsTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      metaRow: { flexDirection: "row" as const, gap: 8, alignItems: "flex-start" as const },
      metaLabel: { color: theme.colors.foregroundMuted, fontSize: 12, minWidth: 64 },
      metaValue: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      outputBox: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 8,
        padding: 8,
      },
      outputFull: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        lineHeight: 17,
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
            const isExpanded = expanded[button.id] === true;
            const metaRow = (label: string, value: string) => (
              <View key={label} style={styles.metaRow}>
                <Text style={styles.metaLabel}>{label}</Text>
                <Text style={styles.metaValue} selectable>
                  {value}
                </Text>
              </View>
            );
            const chevron = (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isExpanded ? "收起详情" : "展开详情"}
                onPress={() => toggleExpanded(button.id)}
                style={styles.chevronBtn}
              >
                <Text style={styles.chevron}>{isExpanded ? "▾" : "▸"}</Text>
              </Pressable>
            );

            if (isAppButton(button)) {
              return (
                <View key={button.id} style={styles.card}>
                  <View style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={state.status === "opening"}
                      onPress={() => void handleRunApp(button)}
                      style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={styles.label}>{button.label}</Text>
                      <Text style={styles.labelMuted}>
                        打开应用 · {button.app}
                        {button.projectPath ? ` · 项目 ${button.projectPath}` : ""}
                        {button.args?.length ? ` · ${button.args.join(" ")}` : ""}
                      </Text>
                    </Pressable>
                    {state.status === "opening" ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : state.status === "finished" ? (
                      <Text style={state.ok ? styles.okText : styles.errText}>
                        {state.ok ? "✓" : "✕"}
                      </Text>
                    ) : null}
                    {chevron}
                  </View>

                  {!isExpanded && state.status === "finished" ? (
                    <Text style={state.ok ? styles.okText : styles.errText}>{state.detail}</Text>
                  ) : null}

                  {isExpanded ? (
                    <View style={styles.details}>
                      <Text style={styles.detailsTitle}>执行状态</Text>
                      {metaRow("状态", describeAppState(state, now))}
                      {metaRow("应用", button.app)}
                      {button.bundleId ? metaRow("Bundle ID", button.bundleId) : null}
                      {metaRow("项目路径", button.projectPath ?? "（未配置，直接打开/切换应用）")}
                      {button.args?.length ? metaRow("附加参数", button.args.join(" ")) : null}
                      {state.status === "finished" ? (
                        <Text style={state.ok ? styles.okText : styles.errText}>
                          {state.detail}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            }

            // Script button
            const running = state.status === "running";
            const starting = state.status === "starting";
            const output =
              state.status === "running" || state.status === "finished" ? state.output : [];
            const outputTail = output.slice(-3);
            return (
              <View key={button.id} style={styles.card}>
                <View style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={running || starting}
                    onPress={() => void handleStartScript(button)}
                    style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={styles.label}>{button.label}</Text>
                    <Text style={styles.labelMuted}>
                      {button.description ?? button.command}
                    </Text>
                  </Pressable>
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
                  {chevron}
                </View>

                {running && !isExpanded ? (
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

                {!isExpanded && state.status === "finished" ? (
                  <>
                    <Text style={state.ok ? styles.okText : styles.errText}>{state.detail}</Text>
                    {outputTail.length > 0 ? (
                      <Text style={styles.output} numberOfLines={3}>
                        {outputTail.join("\n")}
                      </Text>
                    ) : null}
                  </>
                ) : null}

                {isExpanded ? (
                  <View style={styles.details}>
                    <Text style={styles.detailsTitle}>执行状态</Text>
                    {metaRow("状态", describeScriptState(state, now))}
                    {metaRow("命令", button.command)}
                    {metaRow("工作目录", button.cwd ?? "（项目根目录）")}
                    {state.status === "finished" ? (
                      <Text style={state.ok ? styles.okText : styles.errText}>
                        {state.detail}
                      </Text>
                    ) : null}

                    <View style={[styles.row, { justifyContent: "space-between" }]}>
                      <Text style={styles.metaLabel}>输出（末尾 {output.length} 行）</Text>
                      {running ? (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => void handleStopScript(button)}
                          style={{ paddingHorizontal: 10, paddingVertical: 2 }}
                        >
                          <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>
                            停止
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {output.length > 0 ? (
                      <View style={styles.outputBox}>
                        <Text style={styles.outputFull} selectable>
                          {output.join("\n")}
                        </Text>
                      </View>
                    ) : (
                      <Text style={styles.statusText}>{running ? "执行中…" : "暂无输出"}</Text>
                    )}
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
