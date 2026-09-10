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
  /**
   * Optional project path passed to the app on launch.
   * For Godot this becomes `--path <resolved>`, i.e. "open this project".
   * Relative paths resolve against the Paseo project root, so `.` means the
   * workspace/project root itself and `game/` means `<root>/game`.
   */
  projectPath: z.string().optional(),
  /**
   * Optional extra launch arguments appended after the project path.
   * E.g. `["--editor"]` or `["--headless", "-e"]`.
   */
  args: z.array(z.string()).optional(),
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

// ---------------------------------------------------------------------------
// Plugin-level display locations (plugin.config.json)
// ---------------------------------------------------------------------------

/**
 * Places a workspace panel can be registered in (Paseo's PluginPanelLocation).
 * Paseo registers panel locations once at plugin load, so this is a *plugin*-
 * level setting in plugin.config.json — it cannot vary per project.
 */
export const PANEL_LOCATIONS = ["workspace", "explorer"] as const;
export type PanelLocation = (typeof PANEL_LOCATIONS)[number];
export const DEFAULT_PANEL_LOCATIONS: readonly PanelLocation[] = PANEL_LOCATIONS;

/**
 * Normalize the `locations` field from plugin.config.json. Accepts one or more
 * of "workspace" | "explorer"; duplicates are removed and unknown entries are
 * dropped. A missing / empty / fully invalid list falls back to both locations
 * (a panel registered nowhere would never be reachable).
 */
export function resolvePanelLocations(raw: unknown): {
  locations: PanelLocation[];
  error: string | null;
} {
  if (!Array.isArray(raw)) {
    // Field absent: this is the normal default, not an error.
    return { locations: [...DEFAULT_PANEL_LOCATIONS], error: null };
  }

  const allowed = new Set<string>(PANEL_LOCATIONS);
  const selected = new Set<PanelLocation>();
  const invalid: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && allowed.has(item)) {
      selected.add(item as PanelLocation);
    } else {
      invalid.push(String(item));
    }
  }

  if (selected.size === 0) {
    return {
      locations: [...DEFAULT_PANEL_LOCATIONS],
      error: `locations 为空或全部非法（${invalid.join(", ") || "-"}），已回退为 ${DEFAULT_PANEL_LOCATIONS.join(" + ")}`,
    };
  }

  return {
    // Keep Paseo's canonical order regardless of the order in the config file.
    locations: PANEL_LOCATIONS.filter((location) => selected.has(location)),
    error: invalid.length > 0 ? `locations 已忽略非法值：${invalid.join(", ")}` : null,
  };
}

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
