// Small client-side formatting helpers shared by the panel and the header popover.

/** "12s" / "3m05s". `now` is a millisecond timestamp. */
export function formatElapsed(startedAtIso: string, now: number = Date.now()): string {
  const start = new Date(startedAtIso).getTime();
  if (Number.isNaN(start)) return "";
  const seconds = Math.max(0, Math.round((now - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** Elapsed time up to `finishedAt`, or up to now while the job is still running. */
export function elapsedLabel(startedAtIso: string, finishedAtIso: string | null): string {
  const end = finishedAtIso ? new Date(finishedAtIso).getTime() : Date.now();
  return formatElapsed(startedAtIso, Number.isNaN(end) ? Date.now() : end);
}
