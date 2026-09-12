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

/** A button that shows a coding-plan usage card (auto-refreshing). */
export const usageButtonSchema = z.object({
  type: z.literal("usage"),
  id: z.string().min(1),
  label: z.string().min(1),
  /**
   * Usage provider id. Built-ins: "commandcode", "minimax-cn", "minimax".
   * The daemon also accepts any pi provider name and will try to discover its
   * API key from pi's config files (auth.json / models.json).
   */
  provider: z.string().min(1),
  /**
   * Explicit API key. Stored in paseo.json — prefer apiKeyPath / apiKeyEnv so
   * the secret stays in pi's own credential store.
   */
  apiKey: z.string().optional(),
  /** Env var name to read the key from (e.g. COMMAND_CODE_API_KEY). */
  apiKeyEnv: z.string().optional(),
  /**
   * File path (+ optional `#a.b.c` JSON pointer) to read the key from, e.g.
   * `~/.pi/agent/auth.json#commandcode.key`.
   */
  apiKeyPath: z.string().optional(),
  /** Override the provider API base URL. */
  baseUrl: z.string().optional(),
  /** Auto-refresh interval in minutes. Defaults to 60. */
  refreshIntervalMinutes: z.number().positive().optional(),
  /** Optional subtitle shown under the label. */
  description: z.string().optional(),
  /**
   * Account slot inside the auth file, e.g. `commandcode_1`. Filled in by
   * `load-config` when a CommandCode button is split into one card per account
   * (auto-discovery); users normally do not write this.
   */
  accountSlot: z.string().optional(),
  /**
   * Set by `load-config` on auto-discovered account cards: this account is the
   * one pi authenticates with. The header dropdown uses it to pick its single
   * usage row before the first fetch has returned.
   */
  currentAccount: z.boolean().optional(),
  /**
   * Index of this button in the project's paseo.json. Set by `load-config`
   * because one config button can expand into several cards, so the card index
   * is not the config index. Used when writing the button back.
   */
  sourceIndex: z.number().int().nonnegative().optional(),
});

export const buttonSchema = z.discriminatedUnion("type", [
  appButtonSchema,
  scriptButtonSchema,
  usageButtonSchema,
]);

export type AppButton = z.output<typeof appButtonSchema>;
export type ScriptButton = z.output<typeof scriptButtonSchema>;
export type UsageButton = z.output<typeof usageButtonSchema>;
export type ButtonConfig = z.output<typeof buttonSchema>;

export const DEFAULT_USAGE_REFRESH_MINUTES = 60;

/** Providers with a built-in usage adapter. */
export const BUILTIN_USAGE_PROVIDERS = ["commandcode", "minimax-cn", "minimax"] as const;
export type BuiltinUsageProvider = (typeof BUILTIN_USAGE_PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Normalized usage result (shared by the daemon adapter and the client card)
// ---------------------------------------------------------------------------

export const usageWindowSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Amount consumed in this window, when the provider reports absolute units. */
  used: z.number().nullable(),
  /** Window cap, when the provider reports absolute units. */
  cap: z.number().nullable(),
  /** Remaining quota as a percentage (0–100), when known. */
  remainingPercent: z.number().nullable(),
  /** Reset time, epoch milliseconds, when known. */
  resetAt: z.number().nullable(),
});

export const usageMetricSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const usageResultSchema = z.object({
  ok: z.boolean(),
  provider: z.string(),
  fetchedAt: z.string(),
  account: z.string().nullable(),
  plan: z.string().nullable(),
  /** Where the API key came from, e.g. `~/.pi/agent/auth.json#commandcode.key`. */
  keySource: z.string().nullable(),
  /**
   * True when this button's key is the credential pi currently uses by default
   * (i.e. `auth.json[provider]`). Null when it cannot be determined — no key was
   * found, or the provider has no canonical entry in an auth file.
   */
  isDefault: z.boolean().nullable(),
  /** Account name stored on the active default credential, when known. */
  defaultAccount: z.string().nullable(),
  windows: z.array(usageWindowSchema),
  metrics: z.array(usageMetricSchema),
  details: z.array(usageMetricSchema),
  error: z.string().nullable(),
});

export type UsageWindow = z.output<typeof usageWindowSchema>;
export type UsageMetric = z.output<typeof usageMetricSchema>;
export type UsageResult = z.output<typeof usageResultSchema>;

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
