// Client panel UI. This file compiles only into the app bundle; no Node APIs here.
// Theme tokens available in Paseo 0.7: surface0, foreground, foregroundMuted,
// accent, accentForeground, statusDanger. Use only those.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc, useWorkspace } from "@getpaseo/plugin";
import type {
  AppButton,
  ButtonConfig,
  ScriptButton,
  UsageButton,
  UsageResult,
} from "./config.shared";
import { DEFAULT_USAGE_REFRESH_MINUTES } from "./config.shared";
import {
  loadConfigRpc,
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
  usageConfigSaveRpc,
  usageFetchRpc,
} from "./rpc.shared";

type ButtonRunState =
  | { status: "idle" }
  | { status: "opening" }
  | { status: "starting" }
  | { status: "running"; jobId: string; startedAt: string; output: string[] }
  | { status: "finished"; ok: boolean; detail: string; output: string[] };

interface UsageEntry {
  loading: boolean;
  result: UsageResult | null;
  error: string | null;
}

interface UsageFormState {
  provider: string;
  apiKey: string;
  apiKeyEnv: string;
  apiKeyPath: string;
  baseUrl: string;
  refreshIntervalMinutes: string;
  saving: boolean;
  message: string | null;
  error: string | null;
}

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

function isUsageButton(button: ButtonConfig): button is UsageButton {
  return button.type === "usage";
}

/** "in 59m" style countdown for a window reset timestamp. */
function formatResetCountdown(resetAt: number | null, now: number): string {
  if (!resetAt) return "";
  const diff = resetAt - now;
  if (diff <= 0) return "即将重置";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes}m 后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m 后重置`;
  return `${Math.floor(hours / 24)}d 后重置`;
}

/** One-line summary for a usage card's collapsed state. */
function usageSummaryLine(result: UsageResult | null): string {
  if (!result) return "尚未获取";
  if (!result.ok) return result.error ?? "获取失败";
  const parts: string[] = [];
  for (const metric of result.metrics) {
    if (metric.label === "剩余" || metric.label === "已用") parts.push(`${metric.label} ${metric.value}`);
  }
  for (const window of result.windows) {
    if (window.remainingPercent !== null) {
      parts.push(`${window.label} 剩 ${Math.round(window.remainingPercent)}%`);
    } else if (window.cap !== null && window.used !== null) {
      parts.push(`${window.label} ${window.used.toFixed(2)}/${window.cap.toFixed(2)}`);
    }
  }
  return parts.join(" · ") || "无数据";
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
  const fetchUsageRpcCall = useRpc(usageFetchRpc);
  const saveUsageConfigRpcCall = useRpc(usageConfigSaveRpc);

  const [config, setConfig] = useState<LoadedConfig | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [runStates, setRunStates] = useState<Record<string, ButtonRunState>>({});
  // Which button cards are expanded to show full status + output details.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Coding-plan usage data, keyed by button id.
  const [usage, setUsage] = useState<Record<string, UsageEntry>>({});
  // When set, the panel shows the manual usage-config page for this button id.
  const [configTarget, setConfigTarget] = useState<string | null>(null);
  const [usageForm, setUsageForm] = useState<UsageFormState | null>(null);

  function toggleExpanded(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  const runStatesRef = useRef(runStates);
  runStatesRef.current = runStates;

  const configRef = useRef<LoadedConfig | null>(null);
  configRef.current = config;
  const lastUsageFetchRef = useRef<Record<string, number>>({});

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

  async function loadUsageById(id: string) {
    const button = (configRef.current?.buttons ?? []).find(
      (candidate): candidate is UsageButton => isUsageButton(candidate) && candidate.id === id,
    );
    if (!button || !projectRoot) return;
    lastUsageFetchRef.current[id] = Date.now();
    setUsage((prev) => ({
      ...prev,
      [id]: { loading: true, result: prev[id]?.result ?? null, error: null },
    }));
    try {
      const result = await fetchUsageRpcCall({
        provider: button.provider,
        projectRoot,
        apiKey: button.apiKey ?? null,
        apiKeyEnv: button.apiKeyEnv ?? null,
        apiKeyPath: button.apiKeyPath ?? null,
        baseUrl: button.baseUrl ?? null,
      });
      setUsage((prev) => ({
        ...prev,
        [id]: { loading: false, result, error: result.ok ? null : result.error },
      }));
    } catch (error) {
      setUsage((prev) => ({
        ...prev,
        [id]: { loading: false, result: prev[id]?.result ?? null, error: String(error) },
      }));
    }
  }

  const loadUsageRef = useRef(loadUsageById);
  loadUsageRef.current = loadUsageById;

  // Fetch every usage button whenever the project config loads/reloads.
  useEffect(() => {
    const usageButtons = (config?.buttons ?? []).filter(isUsageButton);
    if (usageButtons.length === 0) return;
    for (const button of usageButtons) void loadUsageRef.current(button.id);
    // config identity changes on load/reload; loadUsageRef is kept current.
  }, [config]);

  // Auto-refresh each usage card on its own interval (default 1h).
  useEffect(() => {
    const timer = setInterval(() => {
      const usageButtons = (configRef.current?.buttons ?? []).filter(isUsageButton);
      const now = Date.now();
      for (const button of usageButtons) {
        const intervalMs =
          (button.refreshIntervalMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES) * 60_000;
        const last = lastUsageFetchRef.current[button.id] ?? 0;
        if (now - last >= intervalMs) void loadUsageRef.current(button.id);
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  function openUsageConfig(button: UsageButton) {
    setConfigTarget(button.id);
    setUsageForm({
      provider: button.provider,
      apiKey: button.apiKey ?? "",
      apiKeyEnv: button.apiKeyEnv ?? "",
      apiKeyPath: button.apiKeyPath ?? "",
      baseUrl: button.baseUrl ?? "",
      refreshIntervalMinutes: String(
        button.refreshIntervalMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES,
      ),
      saving: false,
      message: null,
      error: null,
    });
  }

  async function saveUsageForm() {
    if (!usageForm || !configTarget || !projectRoot) return;
    const minutes = Number(usageForm.refreshIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setUsageForm((form) =>
        form ? { ...form, error: "刷新间隔需为正数（分钟）", message: null } : form,
      );
      return;
    }
    setUsageForm((form) => (form ? { ...form, saving: true, message: null, error: null } : form));
    try {
      const result = await saveUsageConfigRpcCall({
        projectRoot,
        buttonId: configTarget,
        provider: usageForm.provider.trim(),
        apiKey: usageForm.apiKey,
        apiKeyEnv: usageForm.apiKeyEnv,
        apiKeyPath: usageForm.apiKeyPath,
        baseUrl: usageForm.baseUrl,
        refreshIntervalMinutes: minutes,
      });
      if (!result.ok) {
        setUsageForm((form) =>
          form ? { ...form, saving: false, error: result.error ?? "保存失败" } : form,
        );
        return;
      }
      setUsageForm((form) =>
        form ? { ...form, saving: false, message: `已保存到 ${result.source}`, error: null } : form,
      );
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      setUsageForm((form) => (form ? { ...form, saving: false, error: String(error) } : form));
    }
  }

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
      barTrack: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.foregroundMuted,
        opacity: 0.3,
        overflow: "hidden" as const,
      },
      barFill: { height: 6, borderRadius: 3 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        color: theme.colors.foreground,
        fontSize: 13,
      },
      chip: {
        borderWidth: 1,
        borderColor: theme.colors.foregroundMuted,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
      },
      chipActive: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
    };
  }, [theme, layout.compact]);

  const buttons = config?.buttons ?? [];
  const now = Date.now();

  function renderUsageConfig() {
    const button = (config?.buttons ?? []).find(
      (candidate): candidate is UsageButton =>
        isUsageButton(candidate) && candidate.id === configTarget,
    );
    const form = usageForm;
    const set = (patch: Partial<UsageFormState>) =>
      setUsageForm((current) => (current ? { ...current, ...patch } : current));
    const field = (
      label: string,
      value: string,
      onChange: (next: string) => void,
      options?: { secure?: boolean; placeholder?: string; numeric?: boolean },
    ) => (
      <View style={{ gap: 4 }}>
        <Text style={styles.metaLabel}>{label}</Text>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChange}
          placeholder={options?.placeholder ?? ""}
          placeholderTextColor={theme.colors.foregroundMuted}
          secureTextEntry={options?.secure ?? false}
          keyboardType={options?.numeric ? "numeric" : "default"}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
    );
    const backButton = (
      <Pressable
        accessibilityRole="button"
        onPress={() => setConfigTarget(null)}
        style={styles.reloadBtn}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>← 返回</Text>
      </Pressable>
    );

    if (!button || !form) {
      return (
        <View style={styles.emptyCard}>
          <Text style={styles.errText}>找不到要配置的 usage 按钮（配置可能已变化）。</Text>
          {backButton}
        </View>
      );
    }

    return (
      <View style={styles.card}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={styles.detailsTitle}>用量配置 · {button.label}</Text>
          {backButton}
        </View>
        <Text style={styles.labelMuted}>
          留空的字段表示“自动”：daemon 会去 pi 配置（~/.pi/agent/auth.json 等）里搜索 apiKey。
          保存会写回项目根目录的 paseo.json。
        </Text>

        {field("Provider", form.provider, (value) => set({ provider: value }), {
          placeholder: "commandcode",
        })}
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          {["commandcode", "minimax-cn", "minimax"].map((provider) => (
            <Pressable
              key={provider}
              accessibilityRole="button"
              onPress={() => set({ provider })}
              style={[styles.chip, form.provider === provider && styles.chipActive]}
            >
              <Text
                style={{
                  color:
                    form.provider === provider
                      ? theme.colors.accentForeground
                      : theme.colors.foregroundMuted,
                  fontSize: 12,
                }}
              >
                {provider}
              </Text>
            </Pressable>
          ))}
        </View>

        {field("API Key（留空则自动搜索 pi 配置）", form.apiKey, (value) => set({ apiKey: value }), {
          secure: true,
          placeholder: "sk-… / user_…",
        })}
        {field("API Key 环境变量名（可选）", form.apiKeyEnv, (value) => set({ apiKeyEnv: value }), {
          placeholder: "COMMAND_CODE_API_KEY",
        })}
        {field("API Key 文件路径 + 指针（可选）", form.apiKeyPath, (value) => set({ apiKeyPath: value }), {
          placeholder: "~/.pi/agent/auth.json#commandcode.key",
        })}
        {field("Base URL（可选，覆盖默认端点）", form.baseUrl, (value) => set({ baseUrl: value }), {
          placeholder: "https://api.commandcode.ai",
        })}
        {field("自动刷新间隔（分钟）", form.refreshIntervalMinutes, (value) => set({ refreshIntervalMinutes: value }), {
          numeric: true,
          placeholder: "60",
        })}

        <View style={[styles.row, { gap: 8 }]}>
          <Pressable
            accessibilityRole="button"
            disabled={form.saving}
            onPress={() => void saveUsageForm()}
            style={[styles.reloadBtn, form.saving && { opacity: 0.6 }]}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              {form.saving ? "保存中…" : "保存"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => setConfigTarget(null)}
            style={styles.reloadBtn}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>取消</Text>
          </Pressable>
        </View>

        {form.message ? <Text style={styles.okText}>{form.message}</Text> : null}
        {form.error ? <Text style={styles.errText}>{form.error}</Text> : null}
      </View>
    );
  }

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

        {configTarget ? (
          renderUsageConfig()
        ) : !config ? (
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

            // Usage button
            if (isUsageButton(button)) {
              const entry = usage[button.id];
              const result = entry?.result ?? null;
              return (
                <View key={button.id} style={styles.card}>
                  <View style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={isExpanded ? "收起用量详情" : "展开用量详情"}
                      onPress={() => toggleExpanded(button.id)}
                      style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={styles.label}>{button.label}</Text>
                      <Text style={styles.labelMuted}>
                        用量 · {result?.plan ?? button.provider}
                        {result?.account ? ` · ${result.account}` : ""}
                      </Text>
                    </Pressable>
                    {entry?.loading ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="刷新用量"
                      disabled={entry?.loading === true}
                      onPress={() => void loadUsageRef.current(button.id)}
                      style={styles.chevronBtn}
                    >
                      <Text style={styles.chevron}>↻</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="配置用量"
                      onPress={() => openUsageConfig(button)}
                      style={styles.chevronBtn}
                    >
                      <Text style={styles.chevron}>⚙</Text>
                    </Pressable>
                    {chevron}
                  </View>

                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={isExpanded ? "收起用量详情" : "展开用量详情"}
                    onPress={() => toggleExpanded(button.id)}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    {entry?.error ? (
                      <Text style={styles.errText}>{entry.error}</Text>
                    ) : result ? (
                      <Text style={styles.statusText}>{usageSummaryLine(result)}</Text>
                    ) : (
                      <Text style={styles.statusText}>点击卡片或 ▸ 展开/收起，↻ 刷新用量</Text>
                    )}
                  </Pressable>

                  {isExpanded ? (
                    <View style={styles.details}>
                      <Text style={styles.detailsTitle}>用量详情</Text>
                      {(result?.windows ?? []).map((window) => (
                        <View key={window.key} style={{ gap: 4 }}>
                          <View style={styles.row}>
                            <Text style={[styles.metaLabel, { minWidth: 0, flex: 1 }]}>
                              {window.label}
                            </Text>
                            <Text style={styles.metaValue}>
                              {window.remainingPercent !== null
                                ? `剩 ${Math.round(window.remainingPercent)}%`
                                : ""}
                              {window.cap !== null && window.used !== null
                                ? ` · ${window.used.toFixed(2)}/${window.cap.toFixed(2)}`
                                : ""}
                            </Text>
                          </View>
                          {window.remainingPercent !== null ? (
                            <View style={styles.barTrack}>
                              <View
                                style={[
                                  styles.barFill,
                                  {
                                    width: `${Math.max(
                                      0,
                                      Math.min(100, Math.round(window.remainingPercent)),
                                    )}%`,
                                    backgroundColor:
                                      window.remainingPercent <= 10
                                        ? theme.colors.statusDanger
                                        : theme.colors.accent,
                                  },
                                ]}
                              />
                            </View>
                          ) : null}
                          {window.resetAt ? (
                            <Text style={styles.labelMuted}>
                              {formatResetCountdown(window.resetAt, now)}
                            </Text>
                          ) : null}
                        </View>
                      ))}
                      {(result?.metrics ?? []).map((metric) => metaRow(metric.label, metric.value))}
                      {(result?.details ?? []).map((detail) => metaRow(detail.label, detail.value))}
                      {result?.keySource ? metaRow("Key 来源", result.keySource) : null}
                      {result
                        ? metaRow("更新于", new Date(result.fetchedAt).toLocaleTimeString("zh-CN"))
                        : null}
                      {metaRow(
                        "自动刷新",
                        `${button.refreshIntervalMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES} 分钟`,
                      )}
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
