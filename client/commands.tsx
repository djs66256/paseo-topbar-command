// Client panel UI. This file compiles only into the app bundle; no Node APIs here.
//
// Run state lives in ./run-store and usage state in ./usage-store, so this panel,
// the workspace header button and its popover always agree.
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  DEFAULT_USAGE_REFRESH_MINUTES,
  type AppButton,
  type ButtonConfig,
  type ScriptButton,
  type UsageButton,
} from "../shared/config";
import { loadConfigRpc } from "../shared/rpc";
import { elapsedLabel } from "./format";
import { refreshWorkspaceMenu } from "./refresh-bus";
import { runStore, useWorkspaceRuns, type ScriptJobView } from "./run-store";
import { UsageCard } from "./usage-card";
import { usageStore } from "./usage-store";

interface LoadedConfig {
  buttons: ButtonConfig[];
  source: string;
  exists: boolean;
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

const SAMPLE_CONFIG = `{
  "buttons": [
    {
      "type": "app",
      "id": "godot",
      "label": "Godot",
      "app": "Godot",
      "projectPath": "godot",
      "args": ["--editor"]
    },
    {
      "type": "script",
      "id": "export",
      "label": "导出 Web",
      "command": "godot --headless --export-release \\"Web\\""
    },
    {
      "type": "usage",
      "id": "usage-commandcode",
      "label": "CommandCode 用量",
      "provider": "commandcode",
      "refreshIntervalMinutes": 60
    }
  ]
}`;

function isScriptButton(button: ButtonConfig): button is ScriptButton {
  return button.type === "script";
}

function isAppButton(button: ButtonConfig): button is AppButton {
  return button.type === "app";
}

function isUsageButton(button: ButtonConfig): button is UsageButton {
  return button.type === "usage";
}

/** Human-readable status shown in an expanded app/script card. */
function describeJob(job: ScriptJobView | undefined): string {
  if (!job) return "未运行";
  if (job.status === "running") return `运行中 · 已运行 ${elapsedLabel(job.startedAt, null)}`;
  if (job.status === "succeeded") return `执行成功 · 用时 ${elapsedLabel(job.startedAt, job.finishedAt)}`;
  if (job.status === "stopped") return "已停止";
  return `执行失败 · 退出码 ${job.exitCode ?? "被终止"}`;
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
  // True for a reload that must refetch usage regardless of the 60s freshness
  // window (e.g. after switching the default account changed the card slots).
  const [reloadForce, setReloadForce] = useState(false);
  // Which button cards are expanded to show full status + output details.
  // Keyed by card index: one config button can expand into several cards (and
  // hand-written configs may reuse ids).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // When set, the panel shows the manual usage-config page for this paseo.json
  // button index (not the card index — expanded cards share one config button).
  const [configTarget, setConfigTarget] = useState<number | null>(null);
  const [usageForm, setUsageForm] = useState<UsageFormState | null>(null);

  function toggleExpanded(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }

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
        if (cancelled) return;
        setConfig(result);
        // Register this workspace's usage cards and refresh anything stale, so
        // opening the panel is what asks for usage data. The full list is passed
        // so card keys line up with the indices the panel renders.
        usageStore.track(workspaceId, projectRoot, result.buttons);
        void usageStore.fetchWorkspace(workspaceId, reloadForce ? 0 : 60_000);
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
  }, [projectRoot, reloadTick, loadConfig, workspaceId]);

  function reload(force = false) {
    // Keep the header button's menu in sync with the panel.
    refreshWorkspaceMenu(workspaceId);
    setReloadForce(force);
    setReloadTick((tick) => tick + 1);
  }

  function openUsageConfig(button: UsageButton, cardIndex: number) {
    setConfigTarget(button.sourceIndex ?? cardIndex);
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
    if (!usageForm || configTarget === null || !projectRoot) return;
    const minutes = Number(usageForm.refreshIntervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setUsageForm((form) =>
        form ? { ...form, error: "刷新间隔需为正数（分钟）", message: null } : form,
      );
      return;
    }
    setUsageForm((form) => (form ? { ...form, saving: true, message: null, error: null } : form));
    try {
      const result = await usageStore.saveConfig({
        projectRoot,
        buttonIndex: configTarget,
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
      // Re-read the config and refresh the header menu with the new settings.
      reload();
    } catch (error) {
      setUsageForm((form) => (form ? { ...form, saving: false, error: String(error) } : form));
    }
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
      iconBtn: {
        paddingHorizontal: 6,
        paddingVertical: 4,
        borderRadius: 6,
      },
      details: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
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
        borderColor: theme.colors.border,
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
      barTrack: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      barFill: { height: 6, borderRadius: 3 },
      input: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        color: theme.colors.foreground,
        fontSize: 13,
      },
      chip: {
        borderWidth: 1,
        borderColor: theme.colors.border,
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
    const button = buttons.find(
      (candidate): candidate is UsageButton =>
        isUsageButton(candidate) && (candidate.sourceIndex ?? -1) === configTarget,
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
          <Pressable accessibilityRole="button" onPress={() => reload()} style={styles.reloadBtn}>
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
          buttons.map((button, cardIndex) => {
            const cardKey = String(cardIndex);
            const isExpanded = expanded[cardKey] === true;
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
                onPress={() => toggleExpanded(cardKey)}
                style={styles.iconBtn}
              >
                <Icon
                  name={isExpanded ? "ChevronDown" : "ChevronRight"}
                  size={14}
                  color={theme.colors.foregroundMuted}
                />
              </Pressable>
            );

            if (isAppButton(button)) {
              const app = runs.apps[button.id];
              const busy = app?.pending ?? false;
              return (
                <View key={`card-${cardIndex}`} style={styles.card}>
                  <View style={styles.row}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => void runStore.runApp(workspaceId, projectRoot, button)}
                      style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}
                    >
                      <Text style={styles.label}>{button.label}</Text>
                      <Text style={styles.labelMuted}>
                        打开应用 · {button.app}
                        {button.projectPath ? ` · 项目 ${button.projectPath}` : ""}
                        {button.args?.length ? ` · ${button.args.join(" ")}` : ""}
                      </Text>
                    </Pressable>
                    {busy ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : app ? (
                      <Text style={app.ok ? styles.okText : styles.errText}>{app.ok ? "✓" : "✕"}</Text>
                    ) : null}
                    {chevron}
                  </View>

                  {!isExpanded && app && !busy ? (
                    <Text style={app.ok ? styles.okText : styles.errText}>{app.detail}</Text>
                  ) : null}

                  {isExpanded ? (
                    <View style={styles.details}>
                      <Text style={styles.detailsTitle}>执行状态</Text>
                      {metaRow(
                        "状态",
                        busy ? "打开中…" : app ? (app.ok ? "已打开" : "打开失败") : "未打开",
                      )}
                      {metaRow("应用", button.app)}
                      {button.bundleId ? metaRow("Bundle ID", button.bundleId) : null}
                      {metaRow("项目路径", button.projectPath ?? "（未配置，直接打开/切换应用）")}
                      {button.args?.length ? metaRow("附加参数", button.args.join(" ")) : null}
                      {app && !busy ? (
                        <Text style={app.ok ? styles.okText : styles.errText}>{app.detail}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            }

            if (isUsageButton(button)) {
              return (
                <UsageCard
                  key={`usage-${cardIndex}`}
                  workspaceId={workspaceId}
                  buttonKey={cardKey}
                  button={button}
                  theme={theme}
                  compact={layout.compact}
                  expanded={isExpanded}
                  onToggle={() => toggleExpanded(cardKey)}
                  onConfigure={() => openUsageConfig(button, cardIndex)}
                  onDefaultChanged={() => reload(true)}
                />
              );
            }

            // Script button
            const job = runs.jobs.find((entry) => entry.buttonId === button.id);
            const runningJob = job && job.status === "running" ? job : null;
            const outputTail = job && job.output.length > 0 ? job.output.slice(-3) : [];

            return (
              <View key={`card-${cardIndex}`} style={styles.card}>
                <View style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={runningJob !== null}
                    onPress={() => void runStore.startScript(workspaceId, projectRoot, button)}
                    style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}
                  >
                    <Text style={styles.label}>{button.label}</Text>
                    <Text style={styles.labelMuted}>{button.description ?? button.command}</Text>
                  </Pressable>
                  {runningJob ? (
                    <Text style={styles.statusText}>
                      {elapsedLabel(runningJob.startedAt, null)} 运行中
                    </Text>
                  ) : job ? (
                    <Text style={job.status === "succeeded" ? styles.okText : styles.errText}>
                      {job.status === "succeeded" ? "✓" : "✕"}
                    </Text>
                  ) : null}
                  {chevron}
                </View>

                {runningJob && !isExpanded ? (
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

                {isExpanded ? (
                  <View style={styles.details}>
                    <Text style={styles.detailsTitle}>执行状态</Text>
                    {metaRow("状态", describeJob(job))}
                    {metaRow("命令", button.command)}
                    {metaRow("工作目录", button.cwd?.trim() ? button.cwd : "（项目根目录）")}
                    {job && job.exitCode !== null ? metaRow("退出码", String(job.exitCode)) : null}
                    {job && job.output.length > 0 ? (
                      <View style={styles.outputBox}>
                        <Text style={styles.outputFull} selectable>
                          {job.output.join("\n")}
                        </Text>
                      </View>
                    ) : null}
                    {runningJob ? (
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => void runStore.stopScript(workspaceId, runningJob.jobId)}
                        style={styles.reloadBtn}
                      >
                        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>停止</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : job && !runningJob && outputTail.length > 0 ? (
                  <Text style={styles.output} numberOfLines={3}>
                    {outputTail.join("\n")}
                  </Text>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
