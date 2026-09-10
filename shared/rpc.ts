// RPC contracts shared by the client panel and the daemon handlers.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { buttonSchema } from "./config";

/** Read + validate <projectRoot>/paseo.json on the daemon machine. */
export const loadConfigRpc = defineRpc({
  name: "paseo-topbar-command.load-config",
  input: z.object({ projectRoot: z.string().min(1) }),
  output: z.object({
    buttons: z.array(buttonSchema),
    /** Absolute path of the config file actually read. */
    source: z.string(),
    error: z.string().nullable(),
  }),
});

/**
 * Open a desktop app, switching to it if it is already running.
 * Runs on the daemon machine (macOS: `open -a/-b`, Windows: `start`,
 * Linux: wmctrl/gtk-launch/xdg-open best effort).
 */
export const openAppRpc = defineRpc({
  name: "paseo-topbar-command.open-app",
  input: z.object({
    app: z.string().min(1),
    bundleId: z.string().nullable(),
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
