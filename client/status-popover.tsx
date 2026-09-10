// Popover content for the header button's "运行状态…" item.
//
// Paseo owns the surface: it anchors the popover (or opens a sheet on compact
// layouts), constrains it to 280-440px and scrolls the body. So this renders a
// plain bounded list, without its own scroll container.
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { elapsedLabel } from "./format";
import { runStore, useWorkspaceRuns, type ScriptJobView } from "./run-store";

function statusText(job: ScriptJobView): string {
  if (job.status === "running") return `${elapsedLabel(job.startedAt, null)} · 运行中`;
  if (job.status === "succeeded") return `完成 · 用时 ${elapsedLabel(job.startedAt, job.finishedAt)}`;
  if (job.status === "stopped") return "已停止";
  return `失败 · 退出码 ${job.exitCode ?? "被终止"}`;
}

export function StatusPopover({ theme, layout, workspaceId }: PluginButtonContentProps) {
  const runs = useWorkspaceRuns(workspaceId);

  const styles = useMemo(
    () => ({
      body: { gap: layout.compact ? 12 : 14 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13 },
      job: {
        gap: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        padding: layout.compact ? 10 : 12,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10 },
      label: {
        flex: 1,
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "500" as const,
      },
      status: { color: theme.colors.foregroundMuted, fontSize: 12 },
      okStatus: { color: theme.colors.statusSuccess, fontSize: 12, fontWeight: "600" as const },
      errStatus: { color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" as const },
      output: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
      stop: {
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
      },
      stopLabel: { color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" as const },
    }),
    [theme, layout.compact],
  );

  if (runs.jobs.length === 0) {
    return <Text style={styles.empty}>没有正在运行的脚本。</Text>;
  }

  return (
    <View style={styles.body}>
      {runs.jobs.map((job) => (
        <View key={job.jobId} style={styles.job}>
          <View style={styles.row}>
            <Text style={styles.label} numberOfLines={1}>
              {job.label}
            </Text>
            <Text
              style={
                job.status === "succeeded"
                  ? styles.okStatus
                  : job.status === "running"
                    ? styles.status
                    : styles.errStatus
              }
            >
              {statusText(job)}
            </Text>
          </View>

          {job.output.length > 0 ? (
            <Text style={styles.output} numberOfLines={2}>
              {job.output.slice(-2).join("\n")}
            </Text>
          ) : null}

          {job.status === "running" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`停止 ${job.label}`}
              onPress={() => void runStore.stopScript(workspaceId, job.jobId)}
              style={styles.stop}
            >
              <Text style={styles.stopLabel}>停止</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
