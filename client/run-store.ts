// Per-workspace run state for the plugin's client bundle.
//
// Both the workspace header button (icon dot + status popover) and the Commands
// panel read this store, so a script started from either surface shows up in the
// other one. One poller serves every workspace; it runs only while a job is
// actually running.
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

class RunStore {
  private transport: RunsTransport | null = null;
  private listeners = new Set<() => void>();
  private jobs = new Map<string, ScriptJobView>();
  private apps = new Map<string, AppRunView>();
  private views = new Map<string, WorkspaceRunsView>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  configure(transport: RunsTransport | null): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.transport = transport;
    this.jobs.clear();
    this.apps.clear();
    this.views.clear();
    this.polling = false;
    this.publish();
  }

  /** Stable per workspace until something actually changes. */
  view(workspaceId: string): WorkspaceRunsView {
    const cached = this.views.get(workspaceId);
    if (cached) return cached;

    const prefix = `${workspaceId}${KEY_SEPARATOR}`;
    const jobs: ScriptJobView[] = [];
    for (const [key, job] of this.jobs) {
      if (key.startsWith(prefix)) jobs.push(job);
    }
    const rank = (job: ScriptJobView) => (job.status === "running" ? 0 : 1);
    jobs.sort((a, b) => rank(a) - rank(b) || (a.startedAt < b.startedAt ? 1 : -1));

    const apps: Record<string, AppRunView> = {};
    for (const [key, app] of this.apps) {
      if (key.startsWith(prefix)) apps[key.slice(prefix.length)] = app;
    }

    const view: WorkspaceRunsView = {
      jobs,
      apps,
      running: jobs.reduce((count, job) => (job.status === "running" ? count + 1 : count), 0),
    };
    this.views.set(workspaceId, view);
    return view;
  }

  async startScript(workspaceId: string, projectRoot: string, button: ScriptButton): Promise<void> {
    const transport = this.transport;
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
      this.putJob(workspaceId, jobId, {
        ...base,
        status: "failed",
        finishedAt: startedAt,
        exitCode: null,
        output: [String(error)],
      });
      return;
    }

    if (!result.ok) {
      this.putJob(workspaceId, jobId, {
        ...base,
        status: "failed",
        finishedAt: startedAt,
        exitCode: null,
        output: [result.error ?? "启动失败"],
      });
      return;
    }

    this.putJob(workspaceId, jobId, {
      ...base,
      status: "running",
      finishedAt: null,
      exitCode: null,
      output: [],
    });
    this.ensurePolling();
  }

  async stopScript(workspaceId: string, jobId: string): Promise<void> {
    const key = keyOf(workspaceId, jobId);
    const current = this.jobs.get(key);
    if (!current || current.status !== "running") return;

    try {
      await this.transport?.stop({ jobId });
    } catch {
      // The next poll settles the real state; a failed stop is not fatal here.
    }

    const latest = this.jobs.get(key);
    if (!latest || latest.status !== "running") return;
    this.putJob(workspaceId, jobId, {
      ...latest,
      status: "stopped",
      finishedAt: new Date().toISOString(),
    });
  }

  async runApp(workspaceId: string, projectRoot: string, button: AppButton): Promise<void> {
    const transport = this.transport;
    if (!transport) return;

    const key = keyOf(workspaceId, button.id);
    this.apps.set(key, { pending: true, ok: false, detail: "正在打开…" });
    this.publish();

    try {
      const result = await transport.openApp({
        app: button.app,
        bundleId: button.bundleId ?? null,
        projectRoot,
        projectPath: button.projectPath ?? "",
        args: button.args ?? [],
      });
      this.apps.set(key, {
        pending: false,
        ok: result.ok,
        detail: result.ok ? result.message || `已打开 ${button.label}` : result.message,
      });
    } catch (error) {
      this.apps.set(key, { pending: false, ok: false, detail: String(error) });
    }
    this.publish();
  }

  private putJob(workspaceId: string, jobId: string, job: ScriptJobView): void {
    this.jobs.set(keyOf(workspaceId, jobId), job);
    this.publish();
  }

  private putJobAt(key: string, job: ScriptJobView): void {
    this.jobs.set(key, job);
    this.publish();
  }

  private publish(): void {
    this.views.clear();
    for (const listener of this.listeners) listener();
  }

  private ensurePolling(): void {
    if (this.timer || !this.transport) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const transport = this.transport;
    if (!transport || this.polling) return;

    const running = [...this.jobs.entries()].filter(([, job]) => job.status === "running");
    if (running.length === 0) {
      this.stopPolling();
      return;
    }

    this.polling = true;
    try {
      await Promise.all(
        running.map(async ([key, job]) => {
          let result: RpcOutput<typeof runScriptPollRpc>;
          try {
            result = await transport.poll({ jobId: job.jobId });
          } catch {
            return; // Transient RPC failure: keep polling on the next tick.
          }
          const current = this.jobs.get(key);
          if (!current || current.status !== "running") return;

          if (result.status === "running") {
            this.putJobAt(key, {
              ...current,
              startedAt: result.startedAt ?? current.startedAt,
              output: result.output,
            });
            return;
          }

          const finishedAt = result.finishedAt ?? new Date().toISOString();
          if (result.status === "missing") {
            this.putJobAt(key, { ...current, status: "stopped", finishedAt, output: result.output });
            return;
          }
          this.putJobAt(key, {
            ...current,
            status: result.status === "succeeded" ? "succeeded" : "failed",
            exitCode: result.exitCode,
            finishedAt,
            output: result.output,
          });
        }),
      );
    } finally {
      this.polling = false;
    }
  }
}

export const runStore = new RunStore();

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
