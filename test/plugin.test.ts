// Headless tests for the daemon-side logic: config parsing, paseo.json loading,
// script start/poll/stop, and app opening. No Paseo UI or plugin runtime needed.
//
// Run with: npm test
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfigText } from "../config.shared";
import {
  buildLaunchArgs,
  handleLoadConfig,
  handleOpenApp,
  handleRunScriptPoll,
  handleRunScriptStart,
  handleRunScriptStop,
  stopAllScripts,
} from "../commands.server";

// The handlers take a plugin context they never use; a stub is fine.
const ctx = {} as never;

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    failures.push(`${name}\n${detail}`);
    console.log(`  FAIL ${name}`);
  }
}

async function waitForJob(jobId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await handleRunScriptPoll({ jobId }, ctx);
    if (result.status !== "running") return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

async function main(): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-plugin-test-"));
  const realTmpRoot = await realpath(tmpRoot);
  console.log(`tmp project: ${tmpRoot}\n`);

  // -------------------------------------------------------------------------
  console.log("config parsing (config.shared.ts)");
  // -------------------------------------------------------------------------

  await test("valid config parses", () => {
    const { buttons, error } = parseConfigText(
      JSON.stringify({
        buttons: [
          { type: "app", id: "godot", label: "Godot", app: "Godot" },
          { type: "script", id: "hi", label: "Hi", command: "echo hi" },
        ],
      }),
    );
    assert.equal(error, null);
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].type, "app");
    assert.equal(buttons[1].type, "script");
  });

  await test("unknown top-level keys are tolerated (Paseo's own worktree config)", () => {
    // This is the exact shape used by ~/Documents/github/xiuxian/paseo.json:
    // a `worktree` block plus a `buttons` array.
    const { buttons, error } = parseConfigText(
      JSON.stringify({
        worktree: { setup: "bash scripts/worktree-init.sh" },
        buttons: [{ type: "app", id: "godot", label: "Godot", app: "Godot" }],
      }),
    );
    assert.equal(error, null);
    assert.equal(buttons.length, 1);
  });

  await test("invalid JSON reports an error instead of throwing", () => {
    const { buttons, error } = parseConfigText("{ not json");
    assert.ok(error && error.includes("JSON"));
    assert.equal(buttons.length, 0);
  });

  await test("schema violations report a path", () => {
    const { error } = parseConfigText(
      JSON.stringify({ buttons: [{ type: "script", id: "x" }] }),
    );
    assert.ok(error && error.includes("label"));
  });

  // -------------------------------------------------------------------------
  console.log("\npaseo.json loading (handleLoadConfig)");
  // -------------------------------------------------------------------------

  await test("missing file returns a helpful error", async () => {
    const emptyDir = path.join(tmpRoot, "no-config");
    await mkdir(emptyDir, { recursive: true });
    const result = await handleLoadConfig({ projectRoot: emptyDir }, ctx);
    assert.equal(result.buttons.length, 0);
    assert.ok(result.error && result.error.includes("未找到配置文件"));
    assert.ok(result.source.endsWith("paseo.json"));
  });

  await test("reads and validates the project's paseo.json", async () => {
    await writeFile(
      path.join(tmpRoot, "paseo.json"),
      JSON.stringify({
        worktree: { setup: "echo setup" },
        buttons: [
          { type: "app", id: "godot", label: "Godot", app: "Godot" },
          { type: "script", id: "pwd", label: "Pwd", command: "pwd" },
        ],
      }),
    );
    const result = await handleLoadConfig({ projectRoot: tmpRoot }, ctx);
    assert.equal(result.error, null);
    assert.equal(result.buttons.length, 2);
    assert.equal(result.source, path.join(tmpRoot, "paseo.json"));
  });

  // -------------------------------------------------------------------------
  console.log("\nscript jobs (start / poll / stop)");
  // -------------------------------------------------------------------------

  await test("successful script reports exit 0 and captured output", async () => {
    const jobId = "test-ok";
    const started = await handleRunScriptStart(
      { jobId, command: "echo paseo-hello && echo second-line", projectRoot: tmpRoot, cwd: "" },
      ctx,
    );
    assert.equal(started.ok, true);
    const result = await waitForJob(jobId);
    assert.equal(result.status, "succeeded");
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes("paseo-hello"));
    assert.ok(result.output.includes("second-line"));
  });

  await test("failing script reports the exit code", async () => {
    const jobId = "test-fail";
    await handleRunScriptStart(
      { jobId, command: "echo boom >&2; exit 3", projectRoot: tmpRoot, cwd: "" },
      ctx,
    );
    const result = await waitForJob(jobId);
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 3);
    assert.ok(result.output.includes("boom"));
  });

  await test("relative cwd resolves against the project root", async () => {
    const sub = path.join(tmpRoot, "subdir");
    await mkdir(sub, { recursive: true });
    const jobId = "test-cwd";
    await handleRunScriptStart(
      {
        jobId,
        command: 'node -e "console.log(process.cwd())"',
        projectRoot: tmpRoot,
        cwd: "subdir",
      },
      ctx,
    );
    const result = await waitForJob(jobId);
    assert.equal(result.status, "succeeded");
    assert.equal(result.output.at(-1), await realpath(sub));
  });

  await test("running job can be stopped", async () => {
    const jobId = "test-stop";
    const started = await handleRunScriptStart(
      { jobId, command: "sleep 30", projectRoot: tmpRoot, cwd: "" },
      ctx,
    );
    assert.equal(started.ok, true);

    // Wait until the poller actually sees it running.
    let running = false;
    for (let i = 0; i < 40 && !running; i += 1) {
      const poll = await handleRunScriptPoll({ jobId }, ctx);
      running = poll.status === "running";
      if (!running) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(running, true, "job should be observed as running");

    const stopped = await handleRunScriptStop({ jobId }, ctx);
    assert.equal(stopped.ok, true);

    const result = await waitForJob(jobId);
    assert.notEqual(result.status, "running");
    assert.notEqual(result.exitCode, 0);
  });

  await test("starting a second job with the same running id is rejected", async () => {
    const jobId = "test-dup";
    await handleRunScriptStart(
      { jobId, command: "sleep 30", projectRoot: tmpRoot, cwd: "" },
      ctx,
    );
    const again = await handleRunScriptStart(
      { jobId, command: "echo nope", projectRoot: tmpRoot, cwd: "" },
      ctx,
    );
    assert.equal(again.ok, false);
    assert.ok(again.error && again.error.includes("正在运行"));
    await handleRunScriptStop({ jobId }, ctx);
    await waitForJob(jobId);
  });

  await test("polling an unknown job id returns missing", async () => {
    const result = await handleRunScriptPoll({ jobId: "does-not-exist" }, ctx);
    assert.equal(result.status, "missing");
  });

  // -------------------------------------------------------------------------
  console.log("\napp opening (handleOpenApp)");
  // -------------------------------------------------------------------------

  await test("app button accepts an optional projectPath + args", () => {
    const { buttons, error } = parseConfigText(
      JSON.stringify({
        buttons: [
          {
            type: "app",
            id: "godot",
            label: "Godot",
            app: "Godot",
            projectPath: ".",
            args: ["--editor"],
          },
        ],
      }),
    );
    assert.equal(error, null);
    const button = buttons[0];
    assert.equal(button.type, "app");
    if (button.type === "app") {
      assert.equal(button.projectPath, ".");
      assert.deepEqual(button.args, ["--editor"]);
    }
  });

  await test("relative projectPath resolves against the project root", () => {
    const { extraArgs, resolvedProjectPath } = buildLaunchArgs({
      app: "Godot",
      bundleId: null,
      projectRoot: tmpRoot,
      projectPath: ".",
    });
    assert.equal(resolvedProjectPath, path.resolve(tmpRoot));
    assert.deepEqual(extraArgs, ["--path", path.resolve(tmpRoot)]);
  });

  await test("subdirectory projectPath + extra args are forwarded", () => {
    const { extraArgs } = buildLaunchArgs({
      app: "Godot",
      bundleId: null,
      projectRoot: tmpRoot,
      projectPath: "game",
      args: ["--editor"],
    });
    assert.deepEqual(extraArgs, ["--path", path.resolve(tmpRoot, "game"), "--editor"]);
  });

  await test("absolute projectPath is left untouched", () => {
    const abs = path.resolve(tmpRoot, "absolute-game");
    const { extraArgs, resolvedProjectPath } = buildLaunchArgs({
      app: "Godot",
      bundleId: null,
      projectRoot: "/somewhere/else",
      projectPath: abs,
    });
    assert.equal(resolvedProjectPath, abs);
    assert.deepEqual(extraArgs, ["--path", abs]);
  });

  await test("no projectPath means plain open/switch (no extra args)", () => {
    const { extraArgs, resolvedProjectPath } = buildLaunchArgs({
      app: "Godot",
      bundleId: null,
      projectRoot: tmpRoot,
    });
    assert.equal(resolvedProjectPath, null);
    assert.deepEqual(extraArgs, []);
  });

  await test("bad bundle id fails cleanly without launching anything", async () => {
    if (process.platform !== "darwin") {
      console.log("       (skipped: only meaningful on macOS)");
      return;
    }
    const result = await handleOpenApp(
      { app: "PaseoDefinitelyNotAnApp", bundleId: "sh.paseo.does-not-exist" },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.ok(result.message.length > 0);
  });

  // -------------------------------------------------------------------------
  stopAllScripts();
  await rm(tmpRoot, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.error(`\n${failures.join("\n\n")}`);
    process.exit(1);
  }
}

void main();
