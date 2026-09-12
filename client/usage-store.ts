// Per-workspace coding-plan usage state for the plugin's client bundle.
//
// Both the Commands panel (usage cards) and the workspace header button (menu
// summaries) read this store, so a fetch triggered by either surface is shared.
// Fetching is on demand plus a per-button auto-refresh interval; one timer serves
// every tracked button.
//
// NOTE: like ./run-store.ts this is a factory + closures, not a `class`. Paseo
// evaluates plugin client bundles with `globalThis.eval`, and Hermes (the iOS and
// Android app engine) compiles every `class` inside a large eval'd function down
// to `undefined`; the first `new X()` then throws "Cannot read property
// 'prototype' of undefined" on iPad. Keep client code class-free.
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

export interface UsageStore {
  subscribe(listener: () => void): () => void;
  configure(transport: UsageTransport | null): void;
  view(workspaceId: string, buttonId: string): UsageEntryView;
  viewWorkspace(workspaceId: string): WorkspaceUsageView;
  trackedButtons(workspaceId: string): readonly UsageButton[];
  track(workspaceId: string, projectRoot: string, buttons: readonly UsageButton[]): void;
  fetch(workspaceId: string, buttonId: string): Promise<void>;
  fetchWorkspace(workspaceId: string, maxAgeMs?: number): Promise<void>;
  saveConfig(
    input: RpcInput<typeof usageConfigSaveRpc>,
  ): Promise<RpcOutput<typeof usageConfigSaveRpc>>;
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

function createUsageStore(): UsageStore {
  let transport: UsageTransport | null = null;
  const listeners = new Set<() => void>();
  const entries = new Map<string, UsageEntryView>();
  const workspaceViews = new Map<string, WorkspaceUsageView>();
  const buttonCache = new Map<string, readonly UsageButton[]>();
  const tracked = new Map<string, TrackedButton>();
  /** In-flight fetches, so a manual refresh and the timer cannot double-fire. */
  const inflight = new Map<string, Promise<void>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function configure(next: UsageTransport | null): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    transport = next;
    entries.clear();
    tracked.clear();
    inflight.clear();
    publish();
  }

  /** Stable per key until that entry changes. */
  function view(workspaceId: string, buttonId: string): UsageEntryView {
    return entries.get(keyOf(workspaceId, buttonId)) ?? EMPTY_VIEW;
  }

  /** Stable per workspace until any of its entries change. */
  function viewWorkspace(workspaceId: string): WorkspaceUsageView {
    const cached = workspaceViews.get(workspaceId);
    if (cached) return cached;

    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const workspaceEntries: Record<string, UsageEntryView> = {};
    let loading = 0;
    for (const [key, entryView] of entries) {
      if (!key.startsWith(prefix)) continue;
      workspaceEntries[key.slice(prefix.length)] = entryView;
      if (entryView.loading) loading += 1;
    }

    const next: WorkspaceUsageView = { entries: workspaceEntries, loading };
    workspaceViews.set(workspaceId, next);
    return next;
  }

  /** Tracked usage buttons of one workspace, in config order and reference-stable. */
  function trackedButtons(workspaceId: string): readonly UsageButton[] {
    const cached = buttonCache.get(workspaceId);
    if (cached) return cached;

    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const buttons: UsageButton[] = [];
    for (const [key, entry] of tracked) {
      if (key.startsWith(prefix)) buttons.push(entry.button);
    }
    buttonCache.set(workspaceId, buttons);
    return buttons;
  }

  /**
   * Replace the set of usage buttons for one workspace. Called whenever the
   * project config loads or reloads. Registering deliberately does not fetch:
   * a surface asks for data when it is actually shown, so opening Paseo with
   * several projects does not fire provider API calls for all of them.
   */
  function track(
    workspaceId: string,
    projectRoot: string,
    buttons: readonly UsageButton[],
  ): void {
    const wanted = new Set<string>();

    for (const button of buttons) {
      const key = keyOf(workspaceId, button.id);
      wanted.add(key);
      tracked.set(key, { workspaceId, projectRoot, button });
    }

    for (const key of [...tracked.keys()]) {
      if (key.startsWith(`${workspaceId}${KEY_SEPARATOR}`) && !wanted.has(key)) {
        tracked.delete(key);
        entries.delete(key);
      }
    }

    ensureTimer();
    publish();
  }

  /** Refresh one button now (manual ↻, or first load of a card). */
  async function fetch(workspaceId: string, buttonId: string): Promise<void> {
    const entry = tracked.get(keyOf(workspaceId, buttonId));
    if (!entry || !transport) return;

    const key = keyOf(workspaceId, buttonId);
    const existing = inflight.get(key);
    if (existing) return existing;

    const task = runFetch(key, entry).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
  }

  /**
   * Refresh a workspace's usage entries. `maxAgeMs` skips entries that are still
   * fresh, so opening the panel or popover repeatedly does not re-hit the API.
   */
  async function fetchWorkspace(workspaceId: string, maxAgeMs = 0): Promise<void> {
    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const now = Date.now();
    const ids = [...tracked.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .filter((id) => {
        if (maxAgeMs <= 0) return true;
        const fetchedAtMs = view(workspaceId, id).fetchedAtMs;
        return fetchedAtMs === null || now - fetchedAtMs >= maxAgeMs;
      });
    await Promise.all(ids.map((id) => fetch(workspaceId, id)));
  }

  async function saveConfig(
    input: RpcInput<typeof usageConfigSaveRpc>,
  ): Promise<RpcOutput<typeof usageConfigSaveRpc>> {
    if (!transport) return { ok: false, error: "插件未就绪", source: "" };
    return transport.saveConfig(input);
  }

  async function runFetch(key: string, entry: TrackedButton): Promise<void> {
    const active = transport;
    if (!active) return;

    const previous = entries.get(key);
    put(key, { ...(previous ?? EMPTY_VIEW), loading: true, error: null });

    const { button } = entry;
    try {
      const result = await active.fetch({
        provider: button.provider,
        projectRoot: entry.projectRoot,
        apiKey: button.apiKey ?? null,
        apiKeyEnv: button.apiKeyEnv ?? null,
        apiKeyPath: button.apiKeyPath ?? null,
        baseUrl: button.baseUrl ?? null,
      });
      put(key, {
        loading: false,
        result,
        error: result.ok ? null : result.error,
        fetchedAtMs: Date.now(),
      });
    } catch (error) {
      put(key, {
        loading: false,
        result: previous?.result ?? null,
        error: String(error),
        // Keep the old timestamp so a failure does not delay the next attempt
        // by a whole refresh interval.
        fetchedAtMs: previous?.fetchedAtMs ?? Date.now(),
      });
    }
  }

  function put(key: string, entry: UsageEntryView): void {
    entries.set(key, entry);
    publish();
  }

  function publish(): void {
    workspaceViews.clear();
    buttonCache.clear();
    for (const listener of listeners) listener();
  }

  function ensureTimer(): void {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, AUTO_REFRESH_TICK_MS);
  }

  async function tick(): Promise<void> {
    if (!transport || tracked.size === 0) {
      if (tracked.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
      return;
    }

    const now = Date.now();
    for (const [key, entry] of [...tracked]) {
      const entryView = entries.get(key);
      if (entryView?.loading) continue;
      const intervalMs =
        (entry.button.refreshIntervalMinutes ?? DEFAULT_USAGE_REFRESH_MINUTES) * 60_000;
      const last = entryView?.fetchedAtMs ?? 0;
      if (now - last >= intervalMs) {
        void fetch(entry.workspaceId, entry.button.id);
      }
    }
  }

  return {
    subscribe,
    configure,
    view,
    viewWorkspace,
    trackedButtons,
    track,
    fetch,
    fetchWorkspace,
    saveConfig,
  };
}

export const usageStore = createUsageStore();

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
