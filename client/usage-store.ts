// Per-workspace coding-plan usage state for the plugin's client bundle.
//
// Both the Commands panel (usage cards) and the workspace header button (menu
// summaries) read this store, so a fetch triggered by either surface is shared.
// Fetching is on demand plus a per-button auto-refresh interval; one timer serves
// every tracked button.
import { useSyncExternalStore } from "react";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { DEFAULT_USAGE_REFRESH_MINUTES, type UsageButton, type UsageResult } from "../shared/config";
import { usageConfigSaveRpc, usageFetchRpc } from "../shared/rpc";

/** Bound RPC calls; the entry wires them to `client.rpc`. */
export interface UsageTransport {
  fetch(input: RpcInput<typeof usageFetchRpc>): Promise<RpcOutput<typeof usageFetchRpc>>;
  saveConfig(
    input: RpcInput<typeof usageConfigSaveRpc>,
  ): Promise<RpcOutput<typeof usageConfigSaveRpc>>;
}

export interface UsageEntryView {
  readonly loading: boolean;
  readonly result: UsageResult | null;
  readonly error: string | null;
  /** Last completed fetch, ms since epoch; drives auto-refresh. Null until fetched. */
  readonly fetchedAtMs: number | null;
}

const EMPTY_VIEW: UsageEntryView = {
  loading: false,
  result: null,
  error: null,
  fetchedAtMs: null,
};

const EMPTY_USAGE: Readonly<Record<string, UsageEntryView>> = {};
const EMPTY_WORKSPACE_VIEW: WorkspaceUsageView = { entries: EMPTY_USAGE, loading: 0 };

/** Aggregate for one workspace, for surfaces that render every usage row at once. */
export interface WorkspaceUsageView {
  readonly entries: Readonly<Record<string, UsageEntryView>>;
  readonly loading: number;
}

const AUTO_REFRESH_TICK_MS = 30_000;
const KEY_SEPARATOR = "\u0000";

/** Usage is per project: two workspaces may point the same provider at different keys. */
function keyOf(workspaceId: string, buttonId: string): string {
  return `${workspaceId}${KEY_SEPARATOR}${buttonId}`;
}

interface TrackedButton {
  workspaceId: string;
  projectRoot: string;
  button: UsageButton;
}

class UsageStore {
  private transport: UsageTransport | null = null;
  private listeners = new Set<() => void>();
  private entries = new Map<string, UsageEntryView>();
  private workspaceViews = new Map<string, WorkspaceUsageView>();
  private buttonCache = new Map<string, readonly UsageButton[]>();
  private tracked = new Map<string, TrackedButton>();
  /** In-flight fetches, so a manual refresh and the timer cannot double-fire. */
  private inflight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  configure(transport: UsageTransport | null): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.transport = transport;
    this.entries.clear();
    this.tracked.clear();
    this.inflight.clear();
    this.publish();
  }

  /** Stable per key until that entry changes. */
  view(workspaceId: string, buttonId: string): UsageEntryView {
    return this.entries.get(keyOf(workspaceId, buttonId)) ?? EMPTY_VIEW;
  }

  /** Stable per workspace until any of its entries change. */
  viewWorkspace(workspaceId: string): WorkspaceUsageView {
    const cached = this.workspaceViews.get(workspaceId);
    if (cached) return cached;

    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const entries: Record<string, UsageEntryView> = {};
    let loading = 0;
    for (const [key, view] of this.entries) {
      if (!key.startsWith(prefix)) continue;
      entries[key.slice(prefix.length)] = view;
      if (view.loading) loading += 1;
    }

    const workspaceView: WorkspaceUsageView = { entries, loading };
    this.workspaceViews.set(workspaceId, workspaceView);
    return workspaceView;
  }

  /** Tracked usage buttons of one workspace, in config order and reference-stable. */
  trackedButtons(workspaceId: string): readonly UsageButton[] {
    const cached = this.buttonCache.get(workspaceId);
    if (cached) return cached;

    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const buttons: UsageButton[] = [];
    for (const [key, tracked] of this.tracked) {
      if (key.startsWith(prefix)) buttons.push(tracked.button);
    }
    this.buttonCache.set(workspaceId, buttons);
    return buttons;
  }

  /**
   * Replace the set of usage buttons for one workspace. Called whenever the
   * project config loads or reloads. Registering deliberately does not fetch:
   * a surface asks for data when it is actually shown, so opening Paseo with
   * several projects does not fire provider API calls for all of them.
   */
  track(workspaceId: string, projectRoot: string, buttons: readonly UsageButton[]): void {
    const wanted = new Set<string>();

    for (const button of buttons) {
      const key = keyOf(workspaceId, button.id);
      wanted.add(key);
      this.tracked.set(key, { workspaceId, projectRoot, button });
    }

    for (const key of [...this.tracked.keys()]) {
      if (key.startsWith(`${workspaceId}${KEY_SEPARATOR}`) && !wanted.has(key)) {
        this.tracked.delete(key);
        this.entries.delete(key);
      }
    }

    this.ensureTimer();
    this.publish();
  }

  /** Refresh one button now (manual ↻, or first load of a card). */
  async fetch(workspaceId: string, buttonId: string): Promise<void> {
    const entry = this.tracked.get(keyOf(workspaceId, buttonId));
    if (!entry || !this.transport) return;

    const existing = this.inflight.get(keyOf(workspaceId, buttonId));
    if (existing) return existing;

    const key = keyOf(workspaceId, buttonId);
    const task = this.runFetch(key, entry).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  /**
   * Refresh a workspace's usage entries. `maxAgeMs` skips entries that are still
   * fresh, so opening the panel or popover repeatedly does not re-hit the API.
   */
  async fetchWorkspace(workspaceId: string, maxAgeMs = 0): Promise<void> {
    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const now = Date.now();
    const ids = [...this.tracked.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((id) => {
        if (maxAgeMs <= 0) return true;
        const fetchedAtMs = this.view(workspaceId, id).fetchedAtMs;
        return fetchedAtMs === null || now - fetchedAtMs >= maxAgeMs;
      });
    await Promise.all(ids.map((id) => this.fetch(workspaceId, id)));
  }

  async saveConfig(
    input: RpcInput<typeof usageConfigSaveRpc>,
  ): Promise<RpcOutput<typeof usageConfigSaveRpc>> {
    if (!this.transport) return { ok: false, error: "插件未就绪", source: "" };
    return this.transport.saveConfig(input);
  }

  private async runFetch(key: string, entry: TrackedButton): Promise<void> {
    const transport = this.transport;
    if (!transport) return;

    const previous = this.entries.get(key);
    this.put(key, { ...(previous ?? EMPTY_VIEW), loading: true, error: null });

    const { button } = entry;
    try {
      const result = await transport.fetch({
        provider: button.provider,
        projectRoot: entry.projectRoot,
        apiKey: button.apiKey ?? null,
        apiKeyEnv: button.apiKeyEnv ?? null,
        apiKeyPath: button.apiKeyPath ?? null,
        baseUrl: button.baseUrl ?? null,
      });
      this.put(key, {
        loading: false,
        result,
        error: result.ok ? null : result.error,
        fetchedAtMs: Date.now(),
      });
    } catch (error) {
      this.put(key, {
        loading: false,
        result: previous?.result ?? null,
        error: String(error),
        // Keep the old timestamp so a failure does not delay the next attempt
        // by a whole refresh interval.
        fetchedAtMs: previous?.fetchedAtMs ?? Date.now(),
      });
    }
  }

  private put(key: string, view: UsageEntryView): void {
    this.entries.set(key, view);
    this.publish();
  }

  private publish(): void {
    this.workspaceViews.clear();
    this.buttonCache.clear();
    for (const listener of this.listeners) listener();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, AUTO_REFRESH_TICK_MS);
  }

  private async tick(): Promise<void> {
    if (!this.transport || this.tracked.size === 0) {
      if (this.tracked.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }

    const now = Date.now();
    for (const [key, entry] of [...this.tracked]) {
      const view = this.entries.get(key);
      if (view?.loading) continue;
      const intervalMs =
        (entry.button.refreshIntervalMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES) * 60_000;
      const last = view?.fetchedAtMs ?? 0;
      if (now - last >= intervalMs) {
        void this.fetch(entry.workspaceId, entry.button.id);
      }
    }
  }
}

export const usageStore = new UsageStore();

/** Called by the client entry on load, and with `null` on cleanup. */
export function configureUsage(transport: UsageTransport | null): void {
  usageStore.configure(transport);
}

export function useUsage(workspaceId: string, buttonId: string): UsageEntryView {
  return useSyncExternalStore(
    usageStore.subscribe,
    () => usageStore.view(workspaceId, buttonId),
    () => EMPTY_VIEW,
  );
}

export function useWorkspaceUsage(workspaceId: string): WorkspaceUsageView {
  return useSyncExternalStore(
    usageStore.subscribe,
    () => usageStore.viewWorkspace(workspaceId),
    () => EMPTY_WORKSPACE_VIEW,
  );
}
