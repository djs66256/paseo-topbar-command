// Per-workspace run state for the plugin's client bundle.
//
// Both the workspace header button (icon dot + status popover) and the Commands
// panel read this store, so a script started from either surface shows up in the
// other one. One poller serves every workspace; it runs only while a job is
// actually running.
//
// NOTE: this store is deliberately built from a factory + closures instead of a
// `class`. Paseo evaluates plugin client bundles with `globalThis.eval`, and
// Hermes (the engine of the iOS/Android app) silently compiles every `class` in a
// large eval'd function down to `undefined` — a class expression assignment then
// yields undefined and the first `new X()` throws
// "TypeError: Cannot read property 'prototype' of undefined" on iPad/iPhone only.
// Functions, closures and object literals are unaffected, so keep this file
// class-free.
import { useSyncExternalStore } from "react";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { AppButton, ScriptButton } from "../shared/config";
import {
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
} from "../shared/rpc";

/** Bound RPC calls; the entry wires them to `client.rpc`. */
export interface RunsTransport {
  start(input: RpcInput<typeof runScriptStartRpc>): Promise<RpcOutput<typeof runScriptStartRpc>>;
  poll(input: RpcInput<typeof runScriptPollRpc>): Promise<RpcOutput<typeof runScriptPollRpc>>;
  stop(input: RpcInput<typeof runScriptStopRpc>): Promise<RpcOutput<typeof runScriptStopRpc>>;
  openApp(input: RpcInput<typeof openAppRpc>): Promise<RpcOutput<typeof openAppRpc>>;
}

export type ScriptStatus = "running" | "succeeded" | "failed" | "stopped";

export interface ScriptJobView {
  /** The `paseo.json` button id, used to match a job back to its button. */
  readonly buttonId: string;
  /** Daemon-side job id; unique per workspace. */
  readonly jobId: string;
  readonly label: string;
  readonly command: string;
  readonly status: ScriptStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;
  readonly output: readonly string[];
}

export interface AppRunView {
  readonly pending: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WorkspaceRunsView {
  /** Newest first, running jobs before finished ones. */
  readonly jobs: readonly ScriptJobView[];
  /** Keyed by app button id. */
  readonly apps: Readonly<Record<string, AppRunView>>;
  readonly running: number;
}

export interface RunStore {
  subscribe(listener: () => void): () => void;
  configure(transport: RunsTransport | null): void;
  view(workspaceId: string): WorkspaceRunsView;
  startScript(workspaceId: string, projectRoot: string, button: ScriptButton): Promise<void>;
  stopScript(workspaceId: string, jobId: string): Promise<void>;
  runApp(workspaceId: string, projectRoot: string, button: AppButton): Promise<void>;
}

const EMPTY_VIEW: WorkspaceRunsView = { jobs: [], apps: {}, running: 0 };
const POLL_INTERVAL_MS = 700;
const KEY_SEPARATOR = "\u0000";

/**
 * Daemon-side job ids are global to the plugin subprocess, so two projects that
 * both define a button named `godot` must not collide.
 */
export function scriptJobId(workspaceId: string, buttonId: string): string {
  return `${workspaceId}::${buttonId}`;
}

function keyOf(workspaceId: string, id: string): string {
  return `${workspaceId}${KEY_SEPARATOR}${id}`;
}

function createRunStore(): RunStore {
  let transport: RunsTransport | null = null;
  const listeners = new Set<() => void>();
  const jobs = new Map<string, ScriptJobView>();
  const apps = new Map<string, AppRunView>();
  const views = new Map<string, WorkspaceRunsView>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function configure(next: RunsTransport | null): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    transport = next;
    jobs.clear();
    apps.clear();
    views.clear();
    polling = false;
    publish();
  }

  /** Stable per workspace until something actually changes. */
  function view(workspaceId: string): WorkspaceRunsView {
    const cached = views.get(workspaceId);
    if (cached) return cached;

    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const workspaceJobs: ScriptJobView[] = [];
    for (const [key, job] of jobs) {
      if (key.startsWith(prefix)) workspaceJobs.push(job);
    }
    const rank = (job: ScriptJobView) => (job.status === "running" ? 0 : 1);
    workspaceJobs.sort((a, b) => rank(a) - rank(b) || (a.startedAt < b.startedAt ? 1 : -1));

    const workspaceApps: Record<string, AppRunView> = {};
    for (const [key, app] of apps) {
      if (key.startsWith(prefix)) workspaceApps[key.slice(prefix.length)] = app;
    }

    const next: WorkspaceRunsView = {
      jobs: workspaceJobs,
      apps: workspaceApps,
      running: workspaceJobs.reduce(
        (count, job) => (job.status === "running" ? count + 1 : count),
        0,
      ),
    };
    views.set(workspaceId, next);
    return next;
  }

  async function startScript(
    workspaceId: string,
    projectRoot: string,
    button: ScriptButton,
  ): Promise<void> {
    if (!transport) return;

    const jobId = scriptJobId(workspaceId, button.id);
    const startedAt = new Date().toISOString();
    const base = {
      buttonId: button.id,
      jobId,
      label: button.label,
      command: button.command,
      startedAt,
    };

    let result: RpcOutput<typeof runScriptStartRpc>;
    try {
      result = await transport.start({
        jobId,
        command: button.command,
        projectRoot,
        cwd: button.cwd ?? "",
      });
    } catch (error) {
      putJob(workspaceId, jobId, {
        ...base,
        status: "failed",
        finishedAt: startedAt,
        exitCode: null,
        output: [String(error)],
      });
      return;
    }

    if (!result.ok) {
      putJob(workspaceId, jobId, {
        ...base,
        status: "failed",
        finishedAt: startedAt,
        exitCode: null,
        output: [result.error ?? "启动失败"],
      });
      return;
    }

    putJob(workspaceId, jobId, {
      ...base,
      status: "running",
      finishedAt: null,
      exitCode: null,
      output: [],
    });
    ensurePolling();
  }

  async function stopScript(workspaceId: string, jobId: string): Promise<void> {
    const key = keyOf(workspaceId, jobId);
    const current = jobs.get(key);
    if (!current || current.status !== "running") return;

    try {
      await transport?.stop({ jobId });
    } catch {
      // The next poll settles the real state; a failed stop is not fatal here.
    }

    const latest = jobs.get(key);
    if (!latest || latest.status !== "running") return;
    putJob(workspaceId, jobId, {
      ...latest,
      status: "stopped",
      finishedAt: new Date().toISOString(),
    });
  }

  async function runApp(
    workspaceId: string,
    projectRoot: string,
    button: AppButton,
  ): Promise<void> {
    if (!transport) return;

    const key = keyOf(workspaceId, button.id);
    apps.set(key, { pending: true, ok: false, detail: "正在打开…" });
    publish();

    try {
      const result = await transport.openApp({
        app: button.app,
        bundleId: button.bundleId ?? null,
        projectRoot,
        projectPath: button.projectPath ?? "",
        args: button.args ?? [],
      });
      apps.set(key, {
        pending: false,
        ok: result.ok,
        detail: result.ok ? result.message || `已打开 ${button.label}` : result.message,
      });
    } catch (error) {
      apps.set(key, { pending: false, ok: false, detail: String(error) });
    }
    publish();
  }

  function putJob(workspaceId: string, jobId: string, job: ScriptJobView): void {
    jobs.set(keyOf(workspaceId, jobId), job);
    publish();
  }

  function putJobAt(key: string, job: ScriptJobView): void {
    jobs.set(key, job);
    publish();
  }

  function publish(): void {
    views.clear();
    for (const listener of listeners) listener();
  }

  function ensurePolling(): void {
    if (timer || !transport) return;
    timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  async function tick(): Promise<void> {
    const active = transport;
    if (!active || polling) return;

    const running = [...jobs.entries()].filter(([, job]) => job.status === "running");
    if (running.length === 0) {
      stopPolling();
      return;
    }

    polling = true;
    try {
      await Promise.all(
        running.map(async ([key, job]) => {
          let result: RpcOutput<typeof runScriptPollRpc>;
          try {
            result = await active.poll({ jobId: job.jobId });
          } catch {
            return; // Transient RPC failure: keep polling on the next tick.
          }
          const current = jobs.get(key);
          if (!current || current.status !== "running") return;

          if (result.status === "running") {
            putJobAt(key, {
              ...current,
              startedAt: result.startedAt ?? current.startedAt,
              output: result.output,
            });
            return;
          }

          const finishedAt = result.finishedAt ?? new Date().toISOString();
          if (result.status === "missing") {
            putJobAt(key, { ...current, status: "stopped", finishedAt, output: result.output });
            return;
          }
          putJobAt(key, {
            ...current,
            status: result.status === "succeeded" ? "succeeded" : "failed",
            exitCode: result.exitCode,
            finishedAt,
            output: result.output,
          });
        }),
      );
    } finally {
      polling = false;
    }
  }

  return { subscribe, configure, view, startScript, stopScript, runApp };
}

export const runStore = createRunStore();

/** Called by the client entry on load, and with `null` on cleanup. */
export function configureRuns(transport: RunsTransport | null): void {
  runStore.configure(transport);
}

export function useWorkspaceRuns(workspaceId: string): WorkspaceRunsView {
  return useSyncExternalStore(
    runStore.subscribe,
    () => runStore.view(workspaceId),
    () => EMPTY_VIEW,
  );
}
