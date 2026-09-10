// RPC contracts shared by the client panel and the daemon handlers.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { buttonSchema, usageResultSchema } from "./config";

/** Read + validate <projectRoot>/paseo.json on the daemon machine. */
export const loadConfigRpc = defineRpc({
  name: "paseo-topbar-command.load-config",
  input: z.object({ projectRoot: z.string().min(1) }),
  output: z.object({
    buttons: z.array(buttonSchema),
    /** Absolute path of the config file actually read. */
    source: z.string(),
    /**
     * False only when the file does not exist (ENOENT). The header button is
     * hidden in that case; a file that exists but fails to validate keeps the
     * button and shows the error instead.
     */
    exists: z.boolean(),
    error: z.string().nullable(),
  }),
});

/**
 * Open a desktop app, switching to it if it is already running.
 * Runs on the daemon machine (macOS: `open -a/-b`, Windows: `start`,
 * Linux: wmctrl/gtk-launch/xdg-open best effort).
 *
 * When `projectPath` is set the app is launched against that project (Godot:
 * `--path <resolved>`); relative paths resolve against `projectRoot`.
 */
export const openAppRpc = defineRpc({
  name: "paseo-topbar-command.open-app",
  input: z.object({
    app: z.string().min(1),
    bundleId: z.string().nullable(),
    /** Paseo project root, used to resolve a relative `projectPath`. */
    projectRoot: z.string(),
    /** Relative-to-root or absolute project path; empty string means none. */
    projectPath: z.string(),
    /** Extra launch args appended after the project path. */
    args: z.array(z.string()),
  }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

/** Start a script job. Returns immediately; the client polls `script-poll`. */
export const runScriptStartRpc = defineRpc({
  name: "paseo-topbar-command.script-start",
  input: z.object({
    jobId: z.string().min(1),
    command: z.string().min(1),
    projectRoot: z.string(),
    /** Relative-to-root or absolute cwd; empty string means project root. */
    cwd: z.string(),
  }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});

/** Poll a running/finished script job for status + output tail. */
export const runScriptPollRpc = defineRpc({
  name: "paseo-topbar-command.script-poll",
  input: z.object({ jobId: z.string().min(1) }),
  output: z.object({
    status: z.enum(["running", "succeeded", "failed", "missing"]),
    exitCode: z.number().nullable(),
    output: z.array(z.string()),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
  }),
});

/** Ask the daemon to terminate a running script job. */
export const runScriptStopRpc = defineRpc({
  name: "paseo-topbar-command.script-stop",
  input: z.object({ jobId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});

/**
 * Fetch coding-plan usage for a provider. The daemon discovers the API key from
 * pi's config files unless an explicit key/env/path is given.
 */
export const usageFetchRpc = defineRpc({
  name: "paseo-topbar-command.usage-fetch",
  input: z.object({
    provider: z.string().min(1),
    projectRoot: z.string(),
    apiKey: z.string().nullable(),
    apiKeyEnv: z.string().nullable(),
    apiKeyPath: z.string().nullable(),
    baseUrl: z.string().nullable(),
  }),
  output: usageResultSchema,
});

/** Patch a usage button's manual config back into the project's paseo.json. */
export const usageConfigSaveRpc = defineRpc({
  name: "paseo-topbar-command.usage-config-save",
  input: z.object({
    projectRoot: z.string(),
    buttonId: z.string().min(1),
    provider: z.string().min(1),
    /** Empty strings mean "unset" (the field is removed). */
    apiKey: z.string(),
    apiKeyEnv: z.string(),
    apiKeyPath: z.string(),
    baseUrl: z.string(),
    refreshIntervalMinutes: z.number().positive(),
  }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable(), source: z.string() }),
});
