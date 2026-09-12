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
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { parseConfigText, type ButtonConfig, type UsageButton } from "../shared/config";
import {
  loadConfigRpc,
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
} from "../shared/rpc";
import { discoverCommandCodeAccounts, isCommandCodeProvider } from "./usage";

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
  input: RpcInput<typeof loadConfigRpc>,
  _context: PluginHandlerContext,
) {
  const configPath = path.join(input.projectRoot, "paseo.json");
  console.log(`${LOG_PREFIX} load-config: projectRoot=${input.projectRoot} file=${configPath}`);

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    // No @types/node dependency here: read the errno code structurally.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const missing = code === "ENOENT";
    console.error(`${LOG_PREFIX} load-config: cannot read ${configPath} — ${describe(error)}`);
    return {
      buttons: [],
      source: configPath,
      // Only a truly absent file hides the header button; any other read failure
      // keeps the button visible so the error can be surfaced.
      exists: !missing,
      error: missing
        ? `未找到配置文件：${configPath}（在项目根目录创建 paseo.json 即可配置按钮）`
        : `读取配置失败：${describe(error)}`,
    };
  }

  const { buttons, error } = parseConfigText(text);
  if (error) {
    console.error(`${LOG_PREFIX} load-config: invalid config in ${configPath} — ${error}`);
    return { buttons, source: configPath, exists: true, error };
  }

  const expanded = await expandCommandCodeButtons(buttons);
  console.log(
    `${LOG_PREFIX} load-config: ok buttons=${expanded.length} (config ${buttons.length}) file=${configPath}`,
  );
  return { buttons: expanded, source: configPath, exists: true, error: null };
}

/** True when the button pins its own credential instead of auto-discovering. */
function hasExplicitUsageKey(button: UsageButton): boolean {
  return Boolean(
    button.apiKey?.trim() || button.apiKeyEnv?.trim() || button.apiKeyPath?.trim(),
  );
}

/**
 * Turn one CommandCode usage button into one card per discovered login.
 *
 * A button with its own `apiKeyPath` / `apiKey` / `apiKeyEnv` is left alone: the
 * user pinned an account on purpose. A plain `provider: "commandcode"` button
 * expands to every distinct `commandcode[-_]*` key in auth.json (deduped by
 * key), each card carrying the `accountSlot` the daemon resolves its key from.
 * `sourceIndex` lets config edits find the original paseo.json entry again.
 * Labels stay exactly as written: the card shows its account (and the plan lives
 * in the expanded details), so a per-card label suffix would just repeat it.
 */
async function expandCommandCodeButtons(buttons: ButtonConfig[]): Promise<ButtonConfig[]> {
  const expanded: ButtonConfig[] = [];
  let accounts: Awaited<ReturnType<typeof discoverCommandCodeAccounts>> | null = null;

  for (const [index, button] of buttons.entries()) {
    if (button.type !== "usage") {
      expanded.push(button);
      continue;
    }
    const withSource: UsageButton = { ...button, sourceIndex: index };
    if (!isCommandCodeProvider(button.provider) || hasExplicitUsageKey(button)) {
      expanded.push(withSource);
      continue;
    }

    accounts ??= await discoverCommandCodeAccounts();
    if (accounts.accounts.length === 0) {
      expanded.push(withSource);
      continue;
    }

    // Flag the currently active account so the header dropdown can show one row
    // before any usage fetch has returned; with no canonical auth entry, the
    // first login stands in for it.
    const hasDefault = accounts.accounts.some((account) => account.isDefault);
    accounts.accounts.forEach((account, accountIndex) => {
      expanded.push({
        ...withSource,
        accountSlot: account.slot,
        currentAccount: account.isDefault || (!hasDefault && accountIndex === 0),
      });
    });
  }

  return expanded;
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

// ---------------------------------------------------------------------------
// Same-project instance detection
// ---------------------------------------------------------------------------

/** Run a command and return its trimmed non-empty stdout lines; [] on failure. */
function runExecFileLines(file: string, args: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        console.error(`${LOG_PREFIX} exec-lines: ${file} 失败 — ${describe(error)}`);
        resolve([]);
        return;
      }
      resolve(
        String(stdout)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      );
    });
  });
}

/**
 * Process names that may identify the app in the process list: the app name,
 * the last bundle-id component (org.godotengine.Godot → Godot), and the app
 * name without a trailing `.app`.
 */
function candidateProcessNames(app: string, bundleId: string | null): string[] {
  const names = new Set<string>();
  if (bundleId) {
    const lastComponent = bundleId.split(".").pop();
    if (lastComponent) names.add(lastComponent);
  }
  names.add(app);
  if (app.endsWith(".app")) names.add(app.slice(0, -4));
  return [...names];
}

/**
 * True when a process command line opens the resolved project: the `--path`
 * flag followed by exactly that path. Matching is token-segment based, so a
 * path containing spaces survives the way `ps` renders argv, and a shorter
 * path can never match a longer one by prefix.
 */
export function commandLineOpensProject(
  commandLine: string,
  resolvedProjectPath: string,
): boolean {
  // macOS `ps` renders the NUL separators between argv entries as the literal
  // text `\012` for directly spawned processes (`open`-launched apps render
  // cleanly). Normalizing them to spaces makes both renderings tokenize alike.
  const normalized = commandLine.replace(/\\012/g, " ");
  const tokens = normalized.split(/\s+/);
  const segments = resolvedProjectPath.split(/\s+/);
  for (let i = 0; i + segments.length <= tokens.length; i++) {
    if (tokens[i] !== "--path") continue;
    let matched = true;
    for (let j = 0; j < segments.length; j++) {
      if (tokens[i + 1 + j] !== segments[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** Read a process's argv from /proc (NUL-separated, lossless). */
async function readProcCmdline(pid: number): Promise<string[] | null> {
  try {
    const buffer = await readFile(`/proc/${pid}/cmdline`);
    return buffer.toString().split("\0").filter(Boolean);
  } catch {
    // Process exited between the listing and this read.
    return null;
  }
}

/** Exact-match a `--path <resolved>` pair in a Linux argv. */
export function procArgvOpensProject(
  argv: readonly string[],
  resolvedProjectPath: string,
): boolean {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "--path" && argv[i + 1] === resolvedProjectPath) return true;
  }
  return false;
}

/** True when the process still exists (checked before focusing a detected instance). */
async function processAlive(pid: number): Promise<boolean> {
  const lines = await runExecFileLines("ps", ["-p", String(pid), "-o", "pid="]);
  return lines.length > 0;
}

/**
 * Find the pid of a running instance of the app that has `resolvedProjectPath`
 * open — identified by the `--path <resolved>` pair in its argv. Returns null
 * when no such instance exists (or the platform can't be probed); callers fall
 * back to launching.
 */
export async function findExistingInstanceForProject(
  app: string,
  bundleId: string | null,
  resolvedProjectPath: string,
  platform: NodeJS.Platform,
): Promise<number | null> {
  const names = new Set(candidateProcessNames(app, bundleId).map((name) => name.toLowerCase()));

  if (platform === "darwin") {
    const lines = await runExecFileLines("ps", ["axww", "-o", "pid=,command="]);
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      const executable = match[2].split(/\s+/)[0] ?? "";
      if (!names.has(path.basename(executable).toLowerCase())) continue;
      if (commandLineOpensProject(match[2], resolvedProjectPath)) return Number(match[1]);
    }
    return null;
  }

  if (platform === "linux") {
    const lines = await runExecFileLines("ps", ["-eo", "pid=,comm="]);
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) continue;
      if (!names.has(match[2].trim().toLowerCase())) continue;
      const argv = await readProcCmdline(Number(match[1]));
      if (argv && procArgvOpensProject(argv, resolvedProjectPath)) return Number(match[1]);
    }
    return null;
  }

  if (platform === "win32") {
    const filters = [...names].map((name) => `Name -like '${name}*'`).join(" -or ");
    const lines = await runExecFileLines("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { ${filters} } | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`,
    ]);
    for (const line of lines) {
      const separator = line.indexOf("|");
      if (separator <= 0) continue;
      const pidText = line.slice(0, separator);
      if (!/^\d+$/.test(pidText)) continue;
      if (commandLineOpensProject(line.slice(separator + 1), resolvedProjectPath)) {
        return Number(pidText);
      }
    }
    return null;
  }

  return null;
}

/**
 * Focus the running instance that already has this project open. Returns
 * "switched" on success, "missing" when the process exited in the meantime
 * (caller launches fresh), or "failed" when it is running but cannot be
 * focused (caller reports without duplicating).
 */
async function focusExistingInstance(
  app: string,
  bundleId: string | null,
  pid: number,
  platform: NodeJS.Platform,
): Promise<{ status: "switched" | "missing" | "failed"; message: string }> {
  if (platform === "darwin") {
    // `open -a/-b` without `-n` activates the running instance — but it would
    // also LAUNCH a bare instance (no project args) if the process were gone,
    // so confirm liveness first.
    if (!(await processAlive(pid))) return { status: "missing", message: "进程已退出" };
    const result = await runExecFile("open", bundleId ? ["-b", bundleId] : ["-a", app]);
    return result.ok
      ? { status: "switched", message: "" }
      : { status: "failed", message: result.message };
  }
  if (platform === "linux") {
    if (!(await processAlive(pid))) return { status: "missing", message: "进程已退出" };
    const result = await runExecFile("wmctrl", ["-a", app]);
    return result.ok
      ? { status: "switched", message: "" }
      : { status: "failed", message: result.message };
  }
  if (platform === "win32") {
    // WScript.Shell.AppActivate raises the process's window by pid; the exit
    // code reflects whether it succeeded.
    const result = await runExecFile("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ok = (New-Object -ComObject WScript.Shell).AppActivate(${pid}); if ($ok) { exit 0 } else { exit 1 }`,
    ]);
    return result.ok
      ? { status: "switched", message: "" }
      : { status: "failed", message: result.message };
  }
  return { status: "failed", message: "当前平台不支持聚焦" };
}

export async function handleOpenApp(
  input: RpcInput<typeof openAppRpc>,
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

  // A configured project path gives an instance a project identity: it is
  // launched with `--path <resolved>` and each editor instance keeps that in
  // its argv for its whole lifetime. So we can tell whether the SAME project is
  // already open (as opposed to *any* instance of the app) and switch to it
  // instead of spawning a duplicate editor.
  if (resolvedProjectPath) {
    const existingPid = await findExistingInstanceForProject(
      app,
      bundleId,
      resolvedProjectPath,
      platform,
    );
    if (existingPid !== null) {
      const switched = await focusExistingInstance(app, bundleId, existingPid, platform);
      if (switched.status === "switched") {
        console.log(
          `${LOG_PREFIX} open-app: switched to existing instance pid=${existingPid} project=${resolvedProjectPath}`,
        );
        return { ok: true, message: `已切换到 ${app}${targetSuffix}` };
      }
      if (switched.status === "failed") {
        console.error(
          `${LOG_PREFIX} open-app: focus failed pid=${existingPid} project=${resolvedProjectPath} — ${switched.message}`,
        );
        return {
          ok: false,
          message: `已打开，但无法聚焦 ${app}${targetSuffix}：${switched.message}`,
        };
      }
      // status === "missing": the instance exited between detection and focus;
      // fall through and launch it fresh.
      console.log(
        `${LOG_PREFIX} open-app: existing instance vanished pid=${existingPid}; launching`,
      );
    }
  }

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
  // X/Wayland compositor and cannot target a specific project; the same-project
  // switch above is what makes a configured project path focus the right
  // instance instead of launching a duplicate.
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
  input: RpcInput<typeof runScriptStartRpc>,
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
  input: RpcInput<typeof runScriptPollRpc>,
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
  input: RpcInput<typeof runScriptStopRpc>,
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
