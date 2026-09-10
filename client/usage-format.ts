// Pure formatting for usage data, shared by the header menu, the popover and the
// panel cards. Ported from the pre-0.8 client so the wording stays identical.
import type { UsageResult } from "../shared/config";

/** "剩 $1.23 · 5 小时 剩 80%" style one-line summary. */
export function usageSummaryLine(result: UsageResult | null): string {
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

/** "59m 后重置" style countdown for a window reset timestamp. */
export function formatResetCountdown(resetAt: number | null, now: number): string {
  if (!resetAt) return "";
  const diff = resetAt - now;
  if (diff <= 0) return "即将重置";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes}m 后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60}m 后重置`;
  return `${Math.floor(hours / 24)}d 后重置`;
}
