// Daemon-side handlers. This file compiles only into the daemon bundle and may
// use Node APIs: reading <projectRoot>/paseo.json, focusing apps, spawning scripts.
//
// Logging: these handlers run in the plugin subprocess, so console.log/console.error
// show up in the plugin log tail (Settings → Plugins → Logs, or
// `paseo plugin logs paseo-topbar-command`). Use a stable prefix so entries are
// greppable, and keep per-invocation lines single-line (the log tail renders one
// entry per console call).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin";
import { parseConfigText } from "./config.shared";

const LOG_PREFIX = "[paseo-topbar-command]";

/** Format an unknown thrown value for logging. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Log an open/focus attempt outcome at the matching level. */
function logOpenAppResult(result: { ok: boolean; message: string }, app: string) {
  if (result.ok) {
    console.log(`${LOG_PREFIX} open-app: ok app=${app}`);
  } else {
    console.error(
      `${LOG_PREFIX} open-app: failed app=${app}${result.message ? ` — ${result.message}` : ""}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export async function handleLoadConfig(
  input: { projectRoot: string },
  _context: PluginHandlerContext,
) {
  const configPath = path.join(input.projectRoot, "paseo.json");
  console.log(`${LOG_PREFIX} load-config: projectRoot=${input.projectRoot} file=${configPath}`);

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    console.error(`${LOG_PREFIX} load-config: cannot read ${configPath} — ${describe(error)}`);
    return {
      buttons: [],
      source: configPath,
      error: `未找到配置文件：${configPath}（在项目根目录创建 paseo.json 即可配置按钮）`,
    };
  }

  const { buttons, error } = parseConfigText(text);
  if (error) {
    console.error(`${LOG_PREFIX} load-config: invalid config in ${configPath} — ${error}`);
  } else {
    console.log(`${LOG_PREFIX} load-config: ok buttons=${buttons.length} file=${configPath}`);
  }
  return { buttons, source: configPath, error };
}

// ---------------------------------------------------------------------------
// Open / focus a desktop app
// ---------------------------------------------------------------------------

function runExecFile(
  file: string,
  args: string[],
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, message: "" });
        return;
      }
      const detail = stderr ? ` — ${String(stderr).trim()}` : ` (${error.message})`;
      resolve({ ok: false, message: `命令 ${file} 失败${detail}` });
    });
  });
}

export interface AppLaunchInput {
  app: string;
  bundleId: string | null;
  /** Paseo project root, used to resolve a relative `projectPath`. */
  projectRoot?: string;
  /** Relative-to-root or absolute project path; empty/undefined means none. */
  projectPath?: string;
  /** Extra launch args appended after the project path. */
  args?: string[];
}

/**
 * Turn the configured project path + extra args into concrete launch args.
 * A relative `projectPath` is resolved against the Paseo project root, so a
 * per-project paseo.json can say `"."` (this repo is the Godot project) or
 * `"game"` (the Godot project lives in a subdirectory).
 */
export function buildLaunchArgs(input: AppLaunchInput): {
  extraArgs: string[];
  resolvedProjectPath: string | null;
} {
  const extraArgs: string[] = [];
  let resolvedProjectPath: string | null = null;

  const projectPath = input.projectPath?.trim();
  if (projectPath) {
    resolvedProjectPath = path.isAbsolute(projectPath)
      ? projectPath
      : path.resolve(input.projectRoot || process.cwd(), projectPath);
    // Godot CLI: `--path <dir>` opens the project stored at <dir>.
    extraArgs.push("--path", resolvedProjectPath);
  }

  if (input.args?.length) extraArgs.push(...input.args);
  return { extraArgs, resolvedProjectPath };
}

export async function handleOpenApp(
  input: AppLaunchInput,
  _context: PluginHandlerContext,
) {
  const { app, bundleId } = input;
  const platform = process.platform;
  const { extraArgs, resolvedProjectPath } = buildLaunchArgs(input);
  const targetSuffix = resolvedProjectPath ? `（项目：${resolvedProjectPath}）` : "";
  console.log(
    `${LOG_PREFIX} open-app: platform=${platform} app=${app} bundleId=${bundleId ?? "-"} args=${JSON.stringify(
      extraArgs,
    )}`,
  );

  if (platform === "darwin") {
    // `open -a <app>` / `open -b <bundleId>` launches the app if it is not
    // running, otherwise switches to the already-running instance.
    const target = bundleId ? ["-b", bundleId] : ["-a", app];
    // With launch args we add `-n` (new instance): an already-running app would
    // just be focused and silently ignore `--args`, so the project would never
    // open. Without args the original open-or-switch behavior is preserved.
    const args =
      extraArgs.length > 0 ? ["-n", ...target, "--args", ...extraArgs] : target;
    const result = await runExecFile("open", args);
    logOpenAppResult(result, app);
    return {
      ok: result.ok,
      message: result.ok
        ? `已打开 ${app}${targetSuffix}`
        : `打开 ${app} 失败：${result.message}`,
    };
  }

  if (platform === "win32") {
    // `start "" <app> <args...>`: the empty string is the window title.
    const result = await runExecFile("cmd", ["/c", "start", "", app, ...extraArgs]);
    logOpenAppResult(result, app);
    return {
      ok: result.ok,
      message: result.ok
        ? `已启动 ${app}${targetSuffix}`
        : `启动 ${app} 失败：${result.message}`,
    };
  }

  // Linux best effort: without launch args, focus if running (wmctrl), else
  // launch (gtk-launch, falling back to xdg-open). Focus depends on a running
  // X/Wayland compositor and cannot target a specific project, so when a project
  // path is configured we always launch instead.
  if (extraArgs.length === 0) {
    const focus = await runExecFile("wmctrl", ["-a", app]);
    if (focus.ok) {
      console.log(`${LOG_PREFIX} open-app: focused via wmctrl app=${app}`);
      return { ok: true, message: `已切换到 ${app}` };
    }
  }
  const launch = await runExecFile("gtk-launch", [app, ...extraArgs]);
  if (launch.ok) {
    console.log(`${LOG_PREFIX} open-app: launched via gtk-launch app=${app}`);
    return { ok: true, message: `已启动 ${app}${targetSuffix}` };
  }
  const open = await runExecFile("xdg-open", [app, ...extraArgs]);
  logOpenAppResult(open, app);
  return {
    ok: open.ok,
    message: open.ok ? `已启动 ${app}${targetSuffix}` : `启动 ${app} 失败：${open.message}`,
  };
}

// ---------------------------------------------------------------------------
// Script jobs: start / poll / stop
// ---------------------------------------------------------------------------

interface ScriptJob {
  jobId: string;
  command: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  running: boolean;
  outputTail: string[];
}

const MAX_TAIL = 60;
const jobs = new Map<string, ScriptJob>();
const children = new Map<string, ChildProcess>();

function pushOutput(job: ScriptJob, chunk: Buffer) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    job.outputTail.push(trimmed);
    if (job.outputTail.length > MAX_TAIL) job.outputTail.shift();
  }
}

/**
 * Kill a script job's whole process tree. On POSIX the child is spawned as its
 * own process group (`detached: true`), so a negative pid signal reaches the
 * shell *and* everything it spawned (e.g. a Godot game the wrapper started).
 */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  const pid = child.pid;
  if (process.platform !== "win32" && typeof pid === "number") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Process group is gone or was never created; fall back to the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

function finishJob(job: ScriptJob, exitCode: number | null) {
  job.exitCode = exitCode;
  job.finishedAt = Date.now();
  job.running = false;

  const durationMs = job.finishedAt - job.startedAt;
  const line = `${LOG_PREFIX} script-finish: jobId=${job.jobId} exitCode=${
    exitCode ?? "null"
  } durationMs=${durationMs} outputLines=${job.outputTail.length}`;
  if (exitCode === 0) {
    console.log(line);
  } else {
    console.error(line);
  }

  // Keep the result available for a few minutes, then drop it.
  setTimeout(() => jobs.delete(job.jobId), 10 * 60 * 1000).unref();
}

export async function handleRunScriptStart(
  input: { jobId: string; command: string; projectRoot: string; cwd: string },
  _context: PluginHandlerContext,
) {
  const existing = jobs.get(input.jobId);
  if (existing?.running) {
    console.error(`${LOG_PREFIX} script-start: rejected jobId=${input.jobId} (already running)`);
    return { ok: false, error: `任务 ${input.jobId} 正在运行中` };
  }

  const cwd = input.cwd
    ? (path.isAbsolute(input.cwd) ? input.cwd : path.join(input.projectRoot, input.cwd))
    : input.projectRoot;

  console.log(
    `${LOG_PREFIX} script-start: jobId=${input.jobId} cwd=${cwd} command=${JSON.stringify(
      input.command,
    )}`,
  );

  const job: ScriptJob = {
    jobId: input.jobId,
    command: input.command,
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    running: true,
    outputTail: [],
  };
  jobs.set(input.jobId, job);

  try {
    const child = spawn(input.command, {
      cwd,
      shell: true,
      env: process.env,
      // POSIX: new process group so a stop can signal the whole tree.
      detached: process.platform !== "win32",
    });
    children.set(input.jobId, child);
    console.log(`${LOG_PREFIX} script-start: spawned jobId=${input.jobId} pid=${child.pid ?? "-"}`);
    child.stdout?.on("data", (chunk: Buffer) => pushOutput(job, chunk));
    child.stderr?.on("data", (chunk: Buffer) => pushOutput(job, chunk));
    child.on("error", (error) => {
      console.error(`${LOG_PREFIX} script-run: spawn error jobId=${input.jobId} — ${error.message}`);
      pushOutput(job, Buffer.from(`[spawn error] ${error.message}`));
      children.delete(input.jobId);
      finishJob(job, 1);
    });
    child.on("close", (code) => {
      children.delete(input.jobId);
      finishJob(job, code);
    });
    return { ok: true, error: null };
  } catch (error) {
    console.error(`${LOG_PREFIX} script-start: failed jobId=${input.jobId} — ${describe(error)}`);
    jobs.delete(input.jobId);
    return {
      ok: false,
      error: `启动脚本失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

type ScriptPollResult = {
  status: "running" | "succeeded" | "failed" | "missing";
  exitCode: number | null;
  output: string[];
  startedAt: string | null;
  finishedAt: string | null;
};

export async function handleRunScriptPoll(
  input: { jobId: string },
  _context: PluginHandlerContext,
): Promise<ScriptPollResult> {
  // Intentionally not logged: the panel polls every ~700ms while a job runs.
  const job = jobs.get(input.jobId);
  if (!job) {
    return { status: "missing", exitCode: null, output: [], startedAt: null, finishedAt: null };
  }
  return {
    status: job.running ? "running" : job.exitCode === 0 ? "succeeded" : "failed",
    exitCode: job.exitCode,
    output: [...job.outputTail],
    startedAt: new Date(job.startedAt).toISOString(),
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
  };
}

export async function handleRunScriptStop(
  input: { jobId: string },
  _context: PluginHandlerContext,
) {
  const child = children.get(input.jobId);
  if (!child) {
    console.error(`${LOG_PREFIX} script-stop: no running child for jobId=${input.jobId}`);
    return { ok: false };
  }
  console.log(
    `${LOG_PREFIX} script-stop: sending SIGTERM jobId=${input.jobId} pid=${child.pid ?? "-"}`,
  );
  try {
    killProcessTree(child, "SIGTERM");
    // Escalate if the process ignores SIGTERM.
    const killTimer = setTimeout(() => {
      killProcessTree(child, "SIGKILL");
    }, 2_000);
    killTimer.unref();
  } catch (error) {
    console.error(`${LOG_PREFIX} script-stop: failed jobId=${input.jobId} — ${describe(error)}`);
    return { ok: false };
  }
  return { ok: true };
}

/** Called from the plugin cleanup: terminate every running script job. */
export function stopAllScripts() {
  const count = children.size;
  if (count > 0) {
    console.log(`${LOG_PREFIX} cleanup: stopping ${count} running script job(s)`);
  }
  for (const child of children.values()) {
    killProcessTree(child, "SIGTERM");
  }
  children.clear();
}

// Backstop: this module only ever loads into the daemon bundle. If the daemon
// kills the plugin subprocess outside the normal shutdown-message path, make sure
// spawned script children do not outlive it.
process.on("exit", () => {
  stopAllScripts();
});
