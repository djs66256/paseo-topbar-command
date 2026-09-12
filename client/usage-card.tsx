// One coding-plan usage card. Extracted into its own component so the panel can
// map over buttons and still call the `useUsage` hook legally (no hooks in loops).
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { DEFAULT_USAGE_REFRESH_MINUTES, type UsageButton, type UsageWindow } from "../shared/config";
import { formatResetCountdown, usageSummaryLine } from "./usage-format";
import { usageStore, useUsage } from "./usage-store";

export interface UsageCardProps {
  workspaceId: string;
  /** Position key of this card in the loaded button list (unique per card). */
  buttonKey: string;
  button: UsageButton;
  theme: {
    colors: {
      surface1: string;
      border: string;
      foreground: string;
      foregroundMuted: string;
      accent: string;
      accentForeground: string;
      statusSuccess: string;
      statusWarning: string;
      statusDanger: string;
    };
  };
  compact: boolean;
  expanded: boolean;
  onToggle(): void;
  onConfigure(): void;
  /** Called after a successful default-account switch (re-expands the cards). */
  onDefaultChanged?(): void;
}

export function UsageCard({
  workspaceId,
  buttonKey,
  button,
  theme,
  compact,
  expanded,
  onToggle,
  onConfigure,
  onDefaultChanged,
}: UsageCardProps) {
  const entry = useUsage(workspaceId, buttonKey);
  const result = entry.result;
  const now = Date.now();
  const [defaultPending, setDefaultPending] = useState(false);
  const [defaultNote, setDefaultNote] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState(false);
  const isDefault = result?.isDefault === true;
  const activeAccount = result?.defaultAccount ?? result?.account ?? null;

  async function applyDefault() {
    setDefaultPending(true);
    setDefaultNote(null);
    setDefaultError(false);
    try {
      const outcome = await usageStore.setDefault(workspaceId, buttonKey);
      if (outcome.ok) {
        setDefaultNote(`已设为默认账号${outcome.account ? ` · ${outcome.account}` : ""}`);
        // Slots may have been re-assigned by the switch, so let the panel
        // re-expand the account cards instead of showing stale pairings.
        onDefaultChanged?.();
      } else {
        setDefaultError(true);
        setDefaultNote(outcome.error ?? "切换默认账号失败");
      }
    } catch (error) {
      setDefaultError(true);
      setDefaultNote(String(error));
    } finally {
      setDefaultPending(false);
    }
  }

  const styles = useMemo(
    () => ({
      card: {
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: compact ? 12 : 14,
        gap: 8,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      label: {
        color: theme.colors.foreground,
        fontSize: compact ? 15 : 16,
        fontWeight: "500" as const,
      },
      labelMuted: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
      statusText: { color: theme.colors.foregroundMuted, fontSize: 13 },
      errText: { color: theme.colors.statusDanger, fontSize: 13, fontWeight: "600" as const },
      iconBtn: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 6 },
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
      // Labels are short fixed strings, so they keep their intrinsic width and
      // never wrap; only the value flexes (wrapping, or truncating when asked).
      metaLabel: { color: theme.colors.foregroundMuted, fontSize: 12, flexGrow: 0, flexShrink: 0 },
      metaValue: {
        color: theme.colors.foreground,
        fontSize: 12,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        textAlign: "right" as const,
      },
      // Window header row: label absorbs the free space, value keeps its intrinsic
      // width. Avoid the `flex: 0` shorthand — react-native-web turns it into
      // `flex: 0 1 0%`, which collapses the value to a tiny wrapping column.
      windowHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      windowLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
      },
      windowValue: {
        color: theme.colors.foreground,
        fontSize: 12,
        flexGrow: 0,
        flexShrink: 0,
        textAlign: "right" as const,
      },
      resetText: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        marginTop: 2,
        textAlign: "right" as const,
      },
      barTrack: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      barFill: { height: 6, borderRadius: 3 },
      // Expanded footer: the account switch and the manual config side by side.
      footer: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        marginTop: 4,
        paddingTop: 8,
      },
      actionBtn: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
      },
      actionBtnDisabled: {
        borderColor: theme.colors.border,
        opacity: 0.55,
      },
      actionLabel: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" as const },
      actionLabelMuted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      footerNote: { color: theme.colors.foregroundMuted, fontSize: 12 },
      footerNoteError: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme, compact],
  );

  const metaRow = (label: string, value: string, truncate = false) => (
    <View key={label} style={styles.metaRow}>
      <Text style={styles.metaLabel} numberOfLines={truncate ? 1 : undefined}>
        {label}
      </Text>
      <Text
        style={styles.metaValue}
        selectable
        numberOfLines={truncate ? 1 : undefined}
        ellipsizeMode="middle"
      >
        {value}
      </Text>
    </View>
  );

  /**
   * The bar tracks consumption, so it grows as quota is spent. Providers that
   * report absolute units use used/cap; percentage-only ones fall back to the
   * complement of the remaining percent.
   */
  const usedPercentOf = (window: UsageWindow): number | null => {
    if (window.cap !== null && window.cap > 0 && window.used !== null) {
      return Math.max(0, Math.min(100, Math.round((window.used / window.cap) * 100)));
    }
    if (window.remainingPercent !== null) {
      return Math.max(0, Math.min(100, Math.round(100 - window.remainingPercent)));
    }
    return null;
  };

  const barColor = (usedPercent: number): string => {
    if (usedPercent > 90) return theme.colors.statusDanger;
    if (usedPercent > 70) return theme.colors.statusWarning;
    return theme.colors.accent;
  };

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "收起用量详情" : "展开用量详情"}
          onPress={onToggle}
          style={({ pressed }) => [{ flex: 1 }, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.label}>{button.label}</Text>
          <Text style={styles.labelMuted}>
            用量 · {result?.plan ?? button.provider}
            {result?.account ? ` · ${result.account}` : ""}
            {button.accountSlot && !result?.account ? ` · ${button.accountSlot}` : ""}
          </Text>
        </Pressable>
        {entry.loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新用量"
          disabled={entry.loading}
          onPress={() => void usageStore.fetch(workspaceId, buttonKey)}
          style={styles.iconBtn}
        >
          <Icon name="RefreshCw" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "收起详情" : "展开详情"}
          onPress={onToggle}
          style={styles.iconBtn}
        >
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "收起用量详情" : "展开用量详情"}
        onPress={onToggle}
        style={({ pressed }) => [pressed && { opacity: 0.7 }]}
      >
        {entry.error ? (
          <Text style={styles.errText}>{entry.error}</Text>
        ) : result ? (
          <Text style={styles.statusText}>{usageSummaryLine(result)}</Text>
        ) : (
          <Text style={styles.statusText}>点击卡片或箭头展开/收起，用 ↻ 刷新用量</Text>
        )}
      </Pressable>

      {expanded ? (
        <View style={styles.details}>
          <Text style={styles.detailsTitle}>用量详情</Text>
          {button.accountSlot
            ? metaRow(
                "账号",
                `${button.accountSlot}${result?.account ? ` · ${result.account}` : ""}`,
              )
            : null}
          {(result?.windows ?? []).map((window) => {
            const usedPercent = usedPercentOf(window);
            return (
              <View key={window.key} style={{ gap: 4 }}>
                <View style={styles.windowHead}>
                  <Text style={styles.windowLabel} numberOfLines={1}>
                    {window.label}
                  </Text>
                  <Text style={styles.windowValue} numberOfLines={1}>
                    {usedPercent !== null ? `已用 ${usedPercent}%` : ""}
                    {window.cap !== null && window.used !== null
                      ? ` · ${window.used.toFixed(2)}/${window.cap.toFixed(2)}`
                      : ""}
                  </Text>
                </View>
                {usedPercent !== null ? (
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${usedPercent}%`, backgroundColor: barColor(usedPercent) },
                      ]}
                    />
                  </View>
                ) : null}
                {window.resetAt ? (
                  <Text style={styles.resetText}>
                    {formatResetCountdown(window.resetAt, now)}
                  </Text>
                ) : null}
              </View>
            );
          })}
          {(result?.metrics ?? []).map((metric) => metaRow(metric.label, metric.value))}
          {(result?.details ?? []).map((detail) => metaRow(detail.label, detail.value))}
          {result?.keySource ? metaRow("Key 来源", result.keySource, true) : null}
          {result ? metaRow("更新于", new Date(result.fetchedAt).toLocaleTimeString("zh-CN")) : null}
          {metaRow(
            "自动刷新",
            `${button.refreshIntervalMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES} 分钟`,
          )}

          <View style={styles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={isDefault ? "当前账号" : "将此账号设为默认"}
              disabled={isDefault || defaultPending}
              onPress={() => void applyDefault()}
              style={[styles.actionBtn, (isDefault || defaultPending) && styles.actionBtnDisabled]}
            >
              <Text
                style={isDefault ? styles.actionLabelMuted : styles.actionLabel}
                numberOfLines={1}
              >
                {isDefault
                  ? activeAccount
                    ? `当前账号 · ${activeAccount}`
                    : "当前账号"
                  : defaultPending
                    ? "切换中…"
                    : "设置为默认"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="配置用量"
              onPress={onConfigure}
              style={styles.actionBtn}
            >
              <Text style={styles.actionLabel}>设置</Text>
            </Pressable>
          </View>
          {defaultNote ? (
            <Text style={defaultError ? styles.footerNoteError : styles.footerNote}>
              {defaultNote}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
