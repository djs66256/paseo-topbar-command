// Daemon-side handlers. This file compiles only into the daemon bundle and may
// use Node APIs: reading <projectRoot>/paseo.json, focusing apps, spawning scripts.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin";
import { parseConfigText } from "./config.shared";

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export async function handleLoadConfig(
  input: { projectRoot: string },
  _context: PluginHandlerContext,
) {
  const configPath = path.join(input.projectRoot, "paseo.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return {
      buttons: [],
      source: configPath,
      error: `未找到配置文件：${configPath}（在项目根目录创建 paseo.json 即可配置按钮）`,
    };
  }
  const { buttons, error } = parseConfigText(text);
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

export async function handleOpenApp(
  input: { app: string; bundleId: string | null },
  _context: PluginHandlerContext,
) {
  const { app, bundleId } = input;
  const platform = process.platform;

  if (platform === "darwin") {
    // `open -b <bundleId>` / `open -a <app>`: launches the app if it is not
    // running, otherwise switches to the already-running instance.
    const args = bundleId ? ["-b", bundleId] : ["-a", app];
    const result = await runExecFile("open", args);
    return {
      ok: result.ok,
      message: result.ok ? `已打开/切换到 ${app}` : `打开 ${app} 失败：${result.message}`,
    };
  }

  if (platform === "win32") {
    const result = await runExecFile("cmd", ["/c", "start", "", app]);
    return {
      ok: result.ok,
      message: result.ok ? `已启动 ${app}` : `启动 ${app} 失败：${result.message}`,
    };
  }

  // Linux best effort: focus if running (wmctrl), else launch (gtk-launch,
  // falling back to xdg-open). Focus depends on a running X/Wayland compositor.
  const focus = await runExecFile("wmctrl", ["-a", app]);
  if (focus.ok) return { ok: true, message: `已切换到 ${app}` };
  const launch = await runExecFile("gtk-launch", [app]);
  if (launch.ok) return { ok: true, message: `已启动 ${app}` };
  const open = await runExecFile("xdg-open", [app]);
  return {
    ok: open.ok,
    message: open.ok ? `已启动 ${app}` : `启动 ${app} 失败：${open.message}`,
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

function finishJob(job: ScriptJob, exitCode: number | null) {
  job.exitCode = exitCode;
  job.finishedAt = Date.now();
  job.running = false;
  // Keep the result available for a few minutes, then drop it.
  setTimeout(() => jobs.delete(job.jobId), 10 * 60 * 1000).unref();
}

export async function handleRunScriptStart(
  input: { jobId: string; command: string; projectRoot: string; cwd: string },
  _context: PluginHandlerContext,
) {
  const existing = jobs.get(input.jobId);
  if (existing?.running) {
    return { ok: false, error: `任务 ${input.jobId} 正在运行中` };
  }

  const cwd = input.cwd
    ? (path.isAbsolute(input.cwd) ? input.cwd : path.join(input.projectRoot, input.cwd))
    : input.projectRoot;

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
    const child = spawn(input.command, { cwd, shell: true, env: process.env });
    children.set(input.jobId, child);
    child.stdout?.on("data", (chunk: Buffer) => pushOutput(job, chunk));
    child.stderr?.on("data", (chunk: Buffer) => pushOutput(job, chunk));
    child.on("error", (error) => {
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
  if (!child) return { ok: false };
  try {
    child.kill("SIGTERM");
    // Escalate if the process ignores SIGTERM.
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 2_000);
    killTimer.unref();
  } catch {
    return { ok: false };
  }
  return { ok: true };
}

/** Called from the plugin cleanup: terminate every running script job. */
export function stopAllScripts() {
  for (const child of children.values()) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  children.clear();
}

// Backstop: this module only ever loads into the daemon bundle. If the daemon
// kills the plugin subprocess outside the normal shutdown-message path, make sure
// spawned script children do not outlive it.
process.on("exit", () => {
  stopAllScripts();
});
