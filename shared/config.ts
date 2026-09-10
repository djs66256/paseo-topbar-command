// Shared schema for the per-project config file: <projectRoot>/paseo.json
// Runs in both the client bundle and the daemon bundle, so no Node/React imports here.
import { z } from "zod";

/** A button that opens/focuses a desktop app (e.g. Godot). */
export const appButtonSchema = z.object({
  type: z.literal("app"),
  /** Stable id; also used as the script job id / React key. */
  id: z.string().min(1),
  /** Button label shown in the panel. */
  label: z.string().min(1),
  /**
   * App name. On macOS it is the app name (`open -a <app>`), e.g. "Godot".
   * If the app is already running, `open -a` switches to it — exactly the
   * "open, or switch if already open" behavior.
   */
  app: z.string().min(1),
  /**
   * Optional macOS bundle id, e.g. "org.godotengine.Godot".
   * When present it is preferred over `app` because `open -b` is the most
   * reliable way to focus an already-running instance.
   */
  bundleId: z.string().optional(),
});

/** A button that runs a free-form shell command in the project directory. */
export const scriptButtonSchema = z.object({
  type: z.literal("script"),
  id: z.string().min(1),
  label: z.string().min(1),
  /** The shell command to run (run via the user's shell). */
  command: z.string().min(1),
  /**
   * Working directory, relative to the project root or absolute.
   * Defaults to the project root when omitted.
   */
  cwd: z.string().optional(),
  /** Optional subtitle shown under the label. */
  description: z.string().optional(),
});

export const buttonSchema = z.discriminatedUnion("type", [
  appButtonSchema,
  scriptButtonSchema,
]);

export type AppButton = z.output<typeof appButtonSchema>;
export type ScriptButton = z.output<typeof scriptButtonSchema>;
export type ButtonConfig = z.output<typeof buttonSchema>;

export const configFileSchema = z.object({
  buttons: z.array(buttonSchema).default([]),
});

export interface ParseConfigResult {
  buttons: ButtonConfig[];
  error: string | null;
}

/**
 * Parse the contents of a paseo.json. Never throws: on any invalid input it
 * returns an empty button list plus a human-readable error to show in the UI.
 */
export function parseConfigText(text: string): ParseConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      buttons: [],
      error: `paseo.json 不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("；");
    return { buttons: [], error: `paseo.json 配置无效：${detail}` };
  }

  return { buttons: parsed.data.buttons, error: null };
}
