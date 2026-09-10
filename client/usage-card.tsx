// One coding-plan usage card. Extracted into its own component so the panel can
// map over buttons and still call the `useUsage` hook legally (no hooks in loops).
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { DEFAULT_USAGE_REFRESH_MINUTES, type UsageButton } from "../shared/config";
import { formatResetCountdown, usageSummaryLine } from "./usage-format";
import { usageStore, useUsage } from "./usage-store";

export interface UsageCardProps {
  workspaceId: string;
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
      statusDanger: string;
    };
  };
  compact: boolean;
  expanded: boolean;
  onToggle(): void;
  onConfigure(): void;
}

export function UsageCard({
  workspaceId,
  button,
  theme,
  compact,
  expanded,
  onToggle,
  onConfigure,
}: UsageCardProps) {
  const entry = useUsage(workspaceId, button.id);
  const result = entry.result;
  const now = Date.now();

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
      metaLabel: { color: theme.colors.foregroundMuted, fontSize: 12, minWidth: 64 },
      metaValue: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      barTrack: {
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      barFill: { height: 6, borderRadius: 3 },
    }),
    [theme, compact],
  );

  const metaRow = (label: string, value: string) => (
    <View key={label} style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} selectable>
        {value}
      </Text>
    </View>
  );

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
          </Text>
        </Pressable>
        {entry.loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新用量"
          disabled={entry.loading}
          onPress={() => void usageStore.fetch(workspaceId, button.id)}
          style={styles.iconBtn}
        >
          <Icon name="RefreshCw" size={13} color={theme.colors.foregroundMuted} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="配置用量"
          onPress={onConfigure}
          style={styles.iconBtn}
        >
          <Icon name="Settings" size={13} color={theme.colors.foregroundMuted} />
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
          {(result?.windows ?? []).map((window) => (
            <View key={window.key} style={{ gap: 4 }}>
              <View style={styles.row}>
                <Text style={[styles.metaLabel, { minWidth: 0, flex: 1 }]}>{window.label}</Text>
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
          {result ? metaRow("更新于", new Date(result.fetchedAt).toLocaleTimeString("zh-CN")) : null}
          {metaRow(
            "自动刷新",
            `${button.refreshIntervalMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES} 分钟`,
          )}
        </View>
      ) : null}
    </View>
  );
}
