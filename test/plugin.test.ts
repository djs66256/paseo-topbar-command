// Headless tests for the daemon-side logic: config parsing, paseo.json loading,
// script start/poll/stop, and app opening. No Paseo UI or plugin runtime needed.
//
// Run with: npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseConfigText, resolvePanelLocations } from "../shared/config";
import {
  credentialKey,
  discoverApiKey,
  handleUsageConfigSave,
  parseCommandCodePayload,
  parseMinimaxPayload,
  providerAliases,
  searchProvider,
} from "../server/usage";
import {
  buildLaunchArgs,
  commandLineOpensProject,
  findExistingInstanceForProject,
  handleLoadConfig,
  handleOpenApp,
  handleRunScriptPoll,
  handleRunScriptStart,
  handleRunScriptStop,
  procArgvOpensProject,
  stopAllScripts,
} from "../server/commands";

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
  console.log("\npanel display locations (resolvePanelLocations)");
  // -------------------------------------------------------------------------

  await test("missing locations defaults to both, without error", () => {
    const { locations, error } = resolvePanelLocations(undefined);
    assert.deepEqual(locations, ["workspace", "explorer"]);
    assert.equal(error, null);
  });

  await test("a single location is honored", () => {
    assert.deepEqual(resolvePanelLocations(["workspace"]).locations, ["workspace"]);
    assert.deepEqual(resolvePanelLocations(["explorer"]).locations, ["explorer"]);
  });

  await test("multiple locations are deduped and put in canonical order", () => {
    const { locations, error } = resolvePanelLocations(["explorer", "workspace", "workspace"]);
    assert.deepEqual(locations, ["workspace", "explorer"]);
    assert.equal(error, null);
  });

  await test("unknown values are dropped and reported", () => {
    const { locations, error } = resolvePanelLocations(["workspace", "sidebar", 42]);
    assert.deepEqual(locations, ["workspace"]);
    assert.ok(error && error.includes("sidebar"));
  });

  await test("empty or fully invalid list falls back to both with an error", () => {
    const empty = resolvePanelLocations([]);
    assert.deepEqual(empty.locations, ["workspace", "explorer"]);
    assert.ok(empty.error);

    const invalid = resolvePanelLocations(["nope"]);
    assert.deepEqual(invalid.locations, ["workspace", "explorer"]);
    assert.ok(invalid.error && invalid.error.includes("nope"));
  });

  // -------------------------------------------------------------------------
  console.log("\nusage button config + key discovery");
  // -------------------------------------------------------------------------

  await test("usage button parses with provider + overrides", () => {
    const { buttons, error } = parseConfigText(
      JSON.stringify({
        buttons: [
          {
            type: "usage",
            id: "cc",
            label: "CommandCode",
            provider: "commandcode",
            apiKeyEnv: "COMMAND_CODE_API_KEY",
            refreshIntervalMinutes: 60,
          },
        ],
      }),
    );
    assert.equal(error, null);
    assert.equal(buttons[0].type, "usage");
    if (buttons[0].type === "usage") {
      assert.equal(buttons[0].provider, "commandcode");
      assert.equal(buttons[0].refreshIntervalMinutes, 60);
    }
  });

  await test("provider aliases prefer the exact id and include variants", () => {
    assert.equal(providerAliases("minimax-cn")[0], "minimax-cn");
    const cc = providerAliases("commandcode");
    assert.ok(cc.includes("command-code"));
    assert.ok(cc.includes("command_code"));
  });

  await test("credentialKey handles api/oauth credential shapes", () => {
    assert.equal(credentialKey({ type: "api", key: "sk-x" }), "sk-x");
    assert.equal(credentialKey({ type: "oauth", access: "tok", key: "k" }), "tok");
    assert.equal(credentialKey("  raw-key  "), "raw-key");
    assert.equal(credentialKey({}), null);
  });

  await test("searchProvider finds auth entries and models.json providers", () => {
    const fromAuth = searchProvider({ commandcode: { type: "api", key: "k1" } }, ["commandcode"]);
    assert.equal(fromAuth?.key, "k1");
    const fromModels = searchProvider(
      { providers: { "coding-plan": { apiKey: "ark-1" } } },
      ["coding-plan"],
    );
    assert.equal(fromModels?.key, "ark-1");
    assert.equal(fromModels?.pointer, "providers.coding-plan.apiKey");
  });

  await test("discoverApiKey: env var wins", async () => {
    const found = await discoverApiKey({
      provider: "commandcode",
      apiKeyEnv: "MY_CC_KEY",
      home: tmpRoot,
      env: { MY_CC_KEY: "env-key" },
    });
    assert.equal(found.key, "env-key");
    assert.equal(found.source, "env:MY_CC_KEY");
  });

  await test("discoverApiKey: explicit file + JSON pointer", async () => {
    const file = path.join(tmpRoot, "creds.json");
    await writeFile(file, JSON.stringify({ commandcode: { type: "api", key: "ptr-key" } }));
    const found = await discoverApiKey({
      provider: "commandcode",
      apiKeyPath: `${file}#commandcode.key`,
      home: tmpRoot,
      env: {},
    });
    assert.equal(found.key, "ptr-key");
  });

  await test("discoverApiKey: auto-searches pi auth.json", async () => {
    const home = path.join(tmpRoot, "home-pi");
    await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      path.join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({
        commandcode: { type: "api", key: "auto-key" },
        "minimax-cn": { type: "api_key", key: "sk-cp-mini" },
      }),
    );
    const cc = await discoverApiKey({ provider: "commandcode", home, env: {} });
    assert.equal(cc.key, "auto-key");
    assert.ok(cc.source && cc.source.includes("auth.json#commandcode"));
    const mm = await discoverApiKey({ provider: "minimax-cn", home, env: {} });
    assert.equal(mm.key, "sk-cp-mini");
  });

  await test("parseCommandCodePayload normalizes credits, windows and plan", () => {
    const parsed = parseCommandCodePayload({
      credits: {
        credits: { monthlyCredits: 57.16, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          fiveHour: { used: 1.26, cap: 14, resetAt: 1789030101209 },
          weekly: { used: 12.82, cap: 35, resetAt: 1789105156687 },
        },
      },
      subscriptions: { data: { planId: "price_abc", status: "active" } },
      summary: { totalCount: 3613, totalCost: 12.72, totalTokens: 634504819 },
      account: "djs",
      orgId: null,
    });
    assert.equal(parsed.windows.length, 2);
    assert.equal(parsed.windows[0].key, "fiveHour");
    assert.ok(parsed.windows[0].remainingPercent !== null && parsed.windows[0].remainingPercent > 90);
    assert.ok(parsed.metrics.some((metric) => metric.label === "剩余"));
    assert.ok(parsed.metrics.some((metric) => metric.label === "Tokens"));
    assert.ok(parsed.plan && parsed.plan.includes("price abc"));
  });

  await test("parseMinimaxPayload normalizes remaining percent windows", () => {
    const parsed = parseMinimaxPayload({
      model_remains: [
        {
          model_name: "general",
          current_interval_remaining_percent: 99,
          current_weekly_remaining_percent: 90,
          end_time: 1789023600000,
          weekly_end_time: 1789315200000,
        },
        { model_name: "video", current_interval_remaining_percent: 100 },
      ],
      base_resp: { status_code: 0, status_msg: "success" },
    });
    assert.equal(parsed.error, null);
    assert.equal(parsed.windows.length, 2);
    assert.equal(parsed.windows[0].key, "interval");
    assert.equal(parsed.windows[0].remainingPercent, 99);
    assert.equal(parsed.windows[0].resetAt, 1789023600000);
    assert.equal(parsed.details.length, 2);
  });

  await test("parseMinimaxPayload surfaces base_resp errors", () => {
    const parsed = parseMinimaxPayload({
      base_resp: { status_code: 1004, status_msg: "cookie is missing" },
    });
    assert.ok(parsed.error && parsed.error.includes("1004"));
    assert.equal(parsed.windows.length, 0);
  });

  await test("usage-config-save patches the button and preserves the file", async () => {
    const dir = path.join(tmpRoot, "usage-save");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "paseo.json");
    await writeFile(
      file,
      JSON.stringify({
        worktree: { setup: "echo hi" },
        buttons: [
          { type: "usage", id: "u", label: "U", provider: "commandcode" },
          { type: "script", id: "s", label: "S", command: "echo" },
        ],
      }),
    );
    const result = await handleUsageConfigSave(
      {
        projectRoot: dir,
        buttonId: "u",
        provider: "minimax-cn",
        apiKey: "",
        apiKeyEnv: "MINIMAX_CN_API_KEY",
        apiKeyPath: "",
        baseUrl: "",
        refreshIntervalMinutes: 30,
      },
      ctx,
    );
    assert.equal(result.ok, true);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      worktree: { setup: string };
      buttons: Array<Record<string, unknown>>;
    };
    assert.equal(saved.worktree.setup, "echo hi");
    const usage = saved.buttons.find((entry) => entry.id === "u");
    assert.equal(usage?.provider, "minimax-cn");
    assert.equal(usage?.apiKeyEnv, "MINIMAX_CN_API_KEY");
    assert.equal(usage?.apiKey, undefined);
    assert.equal(usage?.refreshIntervalMinutes, 30);
    assert.equal(saved.buttons.find((entry) => entry.id === "s")?.command, "echo");
  });

  await test("usage-config-save rejects non-usage buttons", async () => {
    const dir = path.join(tmpRoot, "usage-save-bad");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "paseo.json"),
      JSON.stringify({ buttons: [{ type: "script", id: "s", label: "S", command: "echo" }] }),
    );
    const result = await handleUsageConfigSave(
      {
        projectRoot: dir,
        buttonId: "s",
        provider: "commandcode",
        apiKey: "",
        apiKeyEnv: "",
        apiKeyPath: "",
        baseUrl: "",
        refreshIntervalMinutes: 60,
      },
      ctx,
    );
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.includes("不是 usage"));
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

  // -------------------------------------------------------------------------
  console.log("\napp open: same-project instance detection");
  // -------------------------------------------------------------------------

  await test("commandLineOpensProject matches the --path pair token-segment-wise", () => {
    assert.equal(commandLineOpensProject("Godot --path /a/b/c --editor", "/a/b/c"), true);
    // A path containing spaces: `ps` joins it into several tokens.
    assert.equal(
      commandLineOpensProject("Godot --path /a/b/My Game --editor", "/a/b/My Game"),
      true,
    );
    // macOS `ps` renders NUL separators as the literal text `\012`.
    assert.equal(
      commandLineOpensProject("yes --path\\012/a/b/My Game --editor PATH=/usr/bin", "/a/b/My Game"),
      true,
    );
    // Flags may precede `--path`; single-dash flags may follow it.
    assert.equal(commandLineOpensProject("Godot --editor --path /a/b/c -e", "/a/b/c"), true);
    // The resolved path is always absolute, so a flag merely *starting* with
    // --path cannot be confused.
    assert.equal(commandLineOpensProject("Godot --path-value /a/b/c --editor", "/a/b/c"), false);
  });

  await test("commandLineOpensProject rejects a different project", () => {
    // Longer paths that merely start with ours (no substring false positive).
    assert.equal(commandLineOpensProject("Godot --path /a/b/c2 --editor", "/a/b/c"), false);
    assert.equal(commandLineOpensProject("Godot --path /a/b/c/sub --editor", "/a/b/c"), false);
    assert.equal(commandLineOpensProject("Godot --path /a/b/my-game2 --editor", "/a/b/my-game"), false);
    // No --path flag at all.
    assert.equal(commandLineOpensProject("Godot --editor /a/b/c", "/a/b/c"), false);
  });

  await test("procArgvOpensProject matches exact argv tokens (Linux)", () => {
    const argv = ["/usr/bin/godot", "--editor", "--path", "/a/b/My Game", "-e"];
    assert.equal(procArgvOpensProject(argv, "/a/b/My Game"), true);
    assert.equal(procArgvOpensProject(argv, "/a/b/My"), false);
    assert.equal(procArgvOpensProject(["/usr/bin/godot", "--editor", "/a/b/c"], "/a/b/c"), false);
  });

  await test("live: an instance launched with --path is detected as the same project", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      console.log("       (skipped: needs a POSIX process list)");
      return;
    }
    // `yes` ignores its arguments and runs forever; stand in for the editor.
    const child = spawn("yes", ["--path", realTmpRoot, "--editor"], { stdio: "ignore" });
    try {
      // Give the process a moment to appear in the process list.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const pid = await findExistingInstanceForProject(
        "yes",
        null,
        realTmpRoot,
        process.platform,
      );
      assert.equal(pid, child.pid);
      const other = await findExistingInstanceForProject(
        "yes",
        null,
        path.join(realTmpRoot, "other"),
        process.platform,
      );
      assert.equal(other, null);
    } finally {
      child.kill();
    }
  });

  await test("bad bundle id fails cleanly without launching anything", async () => {
    if (process.platform !== "darwin") {
      console.log("       (skipped: only meaningful on macOS)");
      return;
    }
    const result = await handleOpenApp(
      {
        app: "PaseoDefinitelyNotAnApp",
        bundleId: "sh.paseo.does-not-exist",
        projectRoot: realTmpRoot,
        projectPath: "",
        args: [],
      },
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
