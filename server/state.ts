// Daemon-side storage for the header split button's "last clicked tool".
//
// The left header button repeats the last action the user picked from the
// dropdown; the right one opens the dropdown. That memory has to outlive the
// app, so it is a small JSON file under the daemon's PASEO_HOME rather than a
// client-side store (plugin client code must not use localStorage on iOS).
//
// The file is plugin-owned: never written into paseo.json, so reloading or
// editing a project's buttons cannot lose it.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { lastUsedGetRpc, lastUsedSetRpc } from "../shared/rpc";

const LOG_PREFIX = "[paseo-topbar-command]";

export interface ToolKey {
  kind: "app" | "script";
  id: string;
  index: number;
}

export type LastUsedState = Record<string, ToolKey>;

/**
 * State file location. `PASEO_TOPBAR_STATE_FILE` exists for tests; production
 * uses the daemon home the plugin subprocess is started with.
 */
export function stateFilePath(): string {
  const override = process.env.PASEO_TOPBAR_STATE_FILE?.trim();
  if (override) return override;
  const home = process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
  return path.join(home, "plugin-state", "paseo-topbar-command", "last-used.json");
}

/** Keep only well-formed entries so a hand-edited/corrupt file cannot break the UI. */
export function sanitizeLastUsed(value: unknown): LastUsedState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: LastUsedState = {};
  for (const [workspaceId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (workspaceId.trim() === "") continue;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = record.kind === "app" || record.kind === "script" ? record.kind : null;
    const id = typeof record.id === "string" && record.id.trim() !== "" ? record.id : null;
    const index =
      typeof record.index === "number" && Number.isInteger(record.index) && record.index >= 0
        ? record.index
        : null;
    if (kind === null || id === null || index === null) continue;
    out[workspaceId] = { kind, id, index };
  }
  return out;
}

let cached: LastUsedState | null = null;
let loading: Promise<LastUsedState> | null = null;
let writeChain: Promise<void> = Promise.resolve();

/** Test hook: drop the in-memory copy so the next read hits the file again. */
export function __resetLastUsedCache(): void {
  cached = null;
  loading = null;
}

async function readState(): Promise<LastUsedState> {
  if (cached) return cached;
  if (!loading) {
    loading = (async () => {
      try {
        return sanitizeLastUsed(JSON.parse(await readFile(stateFilePath(), "utf8")) as unknown);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== "ENOENT") {
          console.warn(`${LOG_PREFIX} last-used: read failed — ${String(error)}`);
        }
        return {};
      }
    })();
  }
  cached = await loading;
  loading = null;
  return cached;
}

/** Serialize writes so overlapping clicks cannot interleave tmp-file renames. */
function writeState(state: LastUsedState): Promise<void> {
  const file = stateFilePath();
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const run = writeChain.then(async () => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, body, "utf8");
    await rename(tmp, file);
  });
  // A failed write must not poison the chain for later clicks, so keep the
  // running chain alive while still rejecting this caller's promise.
  writeChain = run.catch(() => {});
  return run;
}

export async function handleLastUsedGet(
  _input: RpcInput<typeof lastUsedGetRpc>,
  _context: PluginHandlerContext,
): Promise<RpcOutput<typeof lastUsedGetRpc>> {
  return { tools: await readState() };
}

export async function handleLastUsedSet(
  input: RpcInput<typeof lastUsedSetRpc>,
  _context: PluginHandlerContext,
): Promise<RpcOutput<typeof lastUsedSetRpc>> {
  const state = await readState();
  state[input.workspaceId] = { kind: input.kind, id: input.id, index: input.index };
  try {
    await writeState(state);
  } catch (error) {
    console.error(`${LOG_PREFIX} last-used: write failed — ${String(error)}`);
    return { ok: false };
  }
  return { ok: true };
}
