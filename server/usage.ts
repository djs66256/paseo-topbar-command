// Daemon-side coding-plan usage adapters.
//
// API keys are discovered from pi's own config files (auth.json / models.json)
// unless the button config pins an explicit key, env var, or file path. Each
// provider adapter normalizes its response into a shared `UsageResult` so the
// client card can render any provider the same way.
//
// Supported built-ins: commandcode, minimax-cn, minimax.
import { readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { UsageMetric, UsageResult, UsageWindow } from "../shared/config";
import { usageConfigSaveRpc, usageFetchRpc, usageSetDefaultRpc } from "../shared/rpc";

const LOG_PREFIX = "[paseo-topbar-command]";
const FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Normalize a reset timestamp (epoch seconds/ms or ISO string) to epoch milliseconds. */
function resetAtMs(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const raw = num(value);
  if (raw === null || raw <= 0) return null;
  return raw >= 1e12 ? Math.round(raw) : Math.round(raw * 1000);
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function tildify(input: string): string {
  const home = os.homedir();
  return input.startsWith(home) ? `~${input.slice(home.length)}` : input;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

function errorResult(
  provider: string,
  keySource: string | null,
  message: string,
): UsageCoreResult {
  return {
    ok: false,
    provider,
    fetchedAt: new Date().toISOString(),
    account: null,
    plan: null,
    keySource,
    windows: [],
    metrics: [],
    details: [],
    error: message,
  };
}

/**
 * A usage result without the auth.json "default account" fields, which only the
 * top-level `handleUsageFetch` can determine (it needs the discovered file).
 */
export type UsageCoreResult = Omit<UsageResult, "isDefault" | "defaultAccount">;

/**
 * The auth.json entry a provider authenticates with when nothing overrides it.
 * Command Code stores alternate logins as `commandcode_1`, `commandcode_2`, …
 * so every alias has to collapse onto the one canonical key.
 */
export function canonicalAuthProvider(provider: string): string {
  const base = provider.trim().toLowerCase();
  if (base === "commandcode" || base === "command-code" || base === "command_code") {
    return "commandcode";
  }
  return base;
}

/** True for `commandcode` and its aliases. */
export function isCommandCodeProvider(provider: string): boolean {
  return canonicalAuthProvider(provider) === "commandcode";
}

/**
 * CommandCode stores extra logins under suffixed auth.json keys
 * (`commandcode_1`, `commandcode-2`, `command_code3`, …). This matches the
 * whole family; other providers only ever match their exact id.
 */
const COMMANDCODE_SLOT_RE = /^command[-_]?code(?:[-_]?\d+)?$/i;

/** Order slots: `commandcode` first, then numbered logins, then the rest. */
function slotRank(slot: string): number {
  const base = slot.trim().toLowerCase();
  if (base === "commandcode") return -2;
  if (base === "command-code" || base === "command_code") return -1;
  const digits = /(\d+)$/.exec(base);
  return digits ? Number(digits[1]) : 1000;
}

/** Every CommandCode slot in an auth record, canonical login first. */
export function commandCodeSlots(record: Record<string, unknown>): string[] {
  return Object.keys(record)
    .filter((slot) => COMMANDCODE_SLOT_RE.test(slot))
    .sort((a, b) => slotRank(a) - slotRank(b) || a.localeCompare(b));
}

export interface CommandCodeAccount {
  /** Slot to address this login by, e.g. `commandcode_1`. */
  slot: string;
  /** Account label stored on the credential, when present. */
  account: string | null;
  /** True for the login `auth.json["commandcode"]` currently points at. */
  isDefault: boolean;
}

/**
 * The distinct CommandCode logins in an auth record.
 *
 * Logins are deduped by key, because the same credential is often stored in
 * several slots (e.g. `commandcode` and `commandcode_2` sharing a key). Each
 * account is addressed by a *dedicated* slot when one exists: `commandcode` is
 * the "current default" pointer, so a card pinned to it would follow every
 * switch instead of staying on its account.
 */
export function commandCodeAccountsFrom(
  record: Record<string, unknown>,
): CommandCodeAccount[] {
  const canonicalKey = credentialKey(record["commandcode"]);
  const grouped = new Map<string, { account: string | null; slots: string[] }>();
  for (const slot of commandCodeSlots(record)) {
    const entry = record[slot];
    const key = credentialKey(entry);
    if (!key) continue;
    const existing = grouped.get(key);
    if (existing) {
      existing.slots.push(slot);
      if (!existing.account) existing.account = credentialAccount(entry);
      continue;
    }
    grouped.set(key, { account: credentialAccount(entry), slots: [slot] });
  }

  return [...grouped.entries()].map(([key, value]) => ({
    slot:
      value.slots.find((slot) => canonicalAuthProvider(slot) !== "commandcode") ??
      value.slots[0],
    account: value.account,
    isDefault: canonicalKey !== null && key === canonicalKey,
  }));
}

// ---------------------------------------------------------------------------
// API key discovery (pi config files)
// ---------------------------------------------------------------------------

const PROVIDER_ENV: Record<string, string[]> = {
  commandcode: ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"],
  "command-code": ["COMMAND_CODE_API_KEY", "COMMANDCODE_API_KEY"],
  "minimax-cn": ["MINIMAX_CN_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  "minimax-io": ["MINIMAX_API_KEY"],
};

/** Aliases to look for in auth.json / models.json, exact provider first. */
export function providerAliases(provider: string): string[] {
  const base = provider.trim().toLowerCase();
  const aliases = new Set<string>([base]);
  aliases.add(base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
  aliases.add(base.replace(/[^a-z0-9]+/g, ""));
  if (base === "commandcode" || base === "command-code" || base === "command_code") {
    ["commandcode", "command-code", "command_code"].forEach((a) => aliases.add(a));
  }
  if (base === "minimax-cn" || base === "minimax_cn" || base === "minimaxcn") {
    ["minimax-cn", "minimax_cn", "minimaxcn", "minimax"].forEach((a) => aliases.add(a));
  }
  if (base === "minimax" || base === "minimax-io") {
    ["minimax", "minimax-io"].forEach((a) => aliases.add(a));
  }
  return [...aliases].filter(Boolean);
}

function keyFileCandidates(home: string): string[] {
  return [
    path.join(home, ".pi", "agent", "auth.json"),
    path.join(home, ".pi", "agent", "models.json"),
    path.join(home, ".pi", "agent", "models-store.json"),
    path.join(home, ".commandcode", "auth.json"),
    path.join(home, ".omp", "agent", "auth.json"),
    path.join(home, ".config", "pi", "agent", "auth.json"),
  ];
}

/** Pull a key out of a pi auth credential (`{type,key}` / `{type,access}`) or a raw string. */
export function credentialKey(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;
  const type = str(value.type) ?? "";
  const order =
    type === "oauth"
      ? ["access", "key", "token", "apiKey"]
      : ["key", "apiKey", "access", "token"];
  for (const field of order) {
    const found = str(value[field]);
    if (found) return found;
  }
  return null;
}

/** Account label stored next to a credential, e.g. `{account: "djs662566"}`. */
export function credentialAccount(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return str(value.account) ?? str(value.name) ?? str(value.login);
}

function accountForPointer(root: unknown, pointer: string | null, value: unknown): string | null {
  if (!pointer) return credentialAccount(value);
  // `commandcode_1.key` / `providers.foo.apiKey` → drop the leaf field name to
  // land on the credential object that carries the account label.
  const holderPath = pointer.replace(/\.(key|apiKey|access|token)$/, "");
  const holder = walkPointer(root, holderPath);
  return credentialAccount(holder) ?? credentialAccount(value);
}

/** Search one parsed JSON document for a provider's credential. */
export function searchProvider(
  record: Record<string, unknown>,
  aliases: readonly string[],
): { key: string; pointer: string; account: string | null } | null {
  for (const alias of aliases) {
    const entry = record[alias];
    const found = credentialKey(entry);
    if (found) return { key: found, pointer: alias, account: credentialAccount(entry) };
  }
  const topLevel = credentialKey(record.apiKey);
  if (topLevel) return { key: topLevel, pointer: "apiKey", account: credentialAccount(record) };
  if (isRecord(record.providers)) {
    for (const alias of aliases) {
      const entry = record.providers[alias];
      if (!isRecord(entry)) continue;
      const found = credentialKey(entry.apiKey) ?? credentialKey(entry);
      if (found) {
        return {
          key: found,
          pointer: `providers.${alias}.apiKey`,
          account: credentialAccount(entry),
        };
      }
    }
  }
  return null;
}

function splitKeyPath(spec: string): { file: string; pointer: string | null } {
  const hash = spec.indexOf("#");
  if (hash < 0) return { file: spec, pointer: null };
  const pointer = spec.slice(hash + 1).trim();
  return { file: spec.slice(0, hash), pointer: pointer === "" ? null : pointer };
}

function walkPointer(root: unknown, pointer: string): unknown {
  let current: unknown = root;
  for (const rawPart of pointer.split(".")) {
    const part = rawPart.trim();
    if (part === "") continue;
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export interface DiscoveredKey {
  key: string | null;
  source: string | null;
  /** Auth file the key was read from, when it came from a file. */
  file: string | null;
  /** Top-level slot inside that file (e.g. `commandcode_1`), when applicable. */
  slot: string | null;
  /** Account label stored next to the credential, when present. */
  account: string | null;
}

function emptyKey(): DiscoveredKey {
  return { key: null, source: null, file: null, slot: null, account: null };
}

/** Resolve an API key: explicit key > env > explicit path > pi auto-discovery. */
export async function discoverApiKey(options: {
  provider: string;
  apiKey?: string | null;
  apiKeyEnv?: string | null;
  apiKeyPath?: string | null;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DiscoveredKey> {
  const inline = options.apiKey?.trim();
  if (inline) return { ...emptyKey(), key: inline, source: "paseo.json（inline apiKey）" };

  const env = options.env ?? process.env;
  const envNames = [
    ...(options.apiKeyEnv?.trim() ? [options.apiKeyEnv.trim()] : []),
    ...(PROVIDER_ENV[options.provider.trim().toLowerCase()] ?? []),
  ];
  for (const name of envNames) {
    const value = env[name];
    if (value && value.trim()) {
      return { ...emptyKey(), key: value.trim(), source: `env:${name}` };
    }
  }

  if (options.apiKeyPath?.trim()) {
    const spec = options.apiKeyPath.trim();
    const { file, pointer } = splitKeyPath(spec);
    const absFile = expandHome(file);
    const json = await readJsonFile(absFile);
    if (json !== null) {
      const value = pointer ? walkPointer(json, pointer) : json;
      const key = credentialKey(value);
      if (key) {
        return {
          key,
          source: spec,
          file: absFile,
          slot: pointer ? pointer.split(".")[0] : null,
          account: accountForPointer(json, pointer, value),
        };
      }
    }
  }

  const home = options.home ?? os.homedir();
  const aliases = providerAliases(options.provider);
  const commandCode = isCommandCodeProvider(options.provider);
  for (const file of keyFileCandidates(home)) {
    const json = await readJsonFile(file);
    if (!isRecord(json)) continue;
    const found = searchProvider(json, aliases);
    if (found) {
      return {
        key: found.key,
        source: `${tildify(file)}#${found.pointer}`,
        file,
        slot: found.pointer.split(".")[0],
        account: found.account,
      };
    }
    // CommandCode keeps extra logins under suffixed keys (`commandcode_1`, …);
    // with no canonical entry present, the first of those is the fallback.
    if (commandCode) {
      const slot = commandCodeSlots(json).find((name) => credentialKey(json[name]));
      if (slot) {
        const entry = json[slot];
        return {
          key: credentialKey(entry),
          source: `${tildify(file)}#${slot}.key`,
          file,
          slot,
          account: credentialAccount(entry),
        };
      }
    }
  }

  return emptyKey();
}

// ---------------------------------------------------------------------------
// Default account (auth.json[provider]) — status + switching
// ---------------------------------------------------------------------------

export interface DefaultStatus {
  /** True when `key` is the active default credential; null when unknown. */
  isDefault: boolean | null;
  /** Account label of the active default credential, when known. */
  defaultAccount: string | null;
  /** Auth file holding the canonical entry, when found. */
  file: string | null;
  /** Canonical slot name inside that file (e.g. `commandcode`). */
  slot: string | null;
}

/** Auth files worth checking, preferring the one the button's key came from. */
function authFileOrder(preferFile: string | null | undefined, home: string): string[] {
  const candidates = keyFileCandidates(home).filter(
    (file) => path.basename(file) === "auth.json",
  );
  const preferred =
    preferFile && path.basename(preferFile) === "auth.json" ? preferFile : null;
  return preferred
    ? [preferred, ...candidates.filter((file) => file !== preferred)]
    : candidates;
}

/** Which auth.json holds the canonical credential for the button's provider. */
function pickAuthFile(preferFile: string | null | undefined, home: string): string {
  const preferred =
    preferFile && path.basename(preferFile) === "auth.json" ? preferFile : null;
  return preferred ?? path.join(home, ".pi", "agent", "auth.json");
}

/**
 * Look up one auth-file slot by name (e.g. `commandcode_1`) across the known
 * auth files. This is how an auto-discovered account card reads its key without
 * ever putting the secret in paseo.json.
 */
export async function resolveAccountSlot(
  slot: string,
  options: { home?: string; preferFile?: string | null } = {},
): Promise<DiscoveredKey> {
  const home = options.home ?? os.homedir();
  for (const file of authFileOrder(options.preferFile, home)) {
    const json = await readJsonFile(file);
    if (!isRecord(json)) continue;
    const entry = json[slot];
    const key = credentialKey(entry);
    if (!key) continue;
    return {
      key,
      source: `${tildify(file)}#${slot}.key`,
      file,
      slot,
      account: credentialAccount(entry),
    };
  }
  return { key: null, source: null, file: null, slot: null, account: null };
}

/** Distinct CommandCode logins found in the known auth files. */
export async function discoverCommandCodeAccounts(
  options: { home?: string; preferFile?: string | null } = {},
): Promise<{ accounts: CommandCodeAccount[]; file: string | null }> {
  const home = options.home ?? os.homedir();
  for (const file of authFileOrder(options.preferFile, home)) {
    const json = await readJsonFile(file);
    if (!isRecord(json)) continue;
    const accounts = commandCodeAccountsFrom(json);
    if (accounts.length > 0) return { accounts, file };
  }
  return { accounts: [], file: null };
}

/** True when `key` is already stored somewhere else in the file. */
function fileHasKey(record: Record<string, unknown>, key: string, exceptSlot: string): boolean {
  for (const [slot, entry] of Object.entries(record)) {
    if (slot === exceptSlot) continue;
    if (credentialKey(entry) === key) return true;
  }
  return false;
}

/** First free `<canonical>_<n>` slot, used to park a displaced default account. */
function freeSlot(record: Record<string, unknown>, canonical: string): string {
  for (let n = 1; n < 1000; n += 1) {
    const slot = `${canonical}_${n}`;
    if (record[slot] === undefined) return slot;
  }
  return `${canonical}_${Date.now()}`;
}

/**
 * Compare a resolved key against the canonical `auth.json[provider]` entry.
 * Returns nulls when the provider has no canonical entry (then "is this the
 * default?" has no answer).
 */
export async function readDefaultStatus(options: {
  provider: string;
  key: string | null;
  preferFile?: string | null;
  home?: string;
}): Promise<DefaultStatus> {
  const unknown: DefaultStatus = {
    isDefault: null,
    defaultAccount: null,
    file: null,
    slot: null,
  };
  if (!options.key) return unknown;

  const canonical = canonicalAuthProvider(options.provider);
  const home = options.home ?? os.homedir();
  for (const file of authFileOrder(options.preferFile, home)) {
    const json = await readJsonFile(file);
    if (!isRecord(json)) continue;
    const entry = json[canonical];
    const currentKey = credentialKey(entry);
    if (!currentKey) continue;
    return {
      isDefault: currentKey === options.key,
      defaultAccount: credentialAccount(entry),
      file,
      slot: canonical,
    };
  }
  return unknown;
}

export interface SetDefaultResult {
  ok: boolean;
  error: string | null;
  /** Auth file that was (or would have been) written. */
  source: string;
  isDefault: boolean;
  account: string | null;
}

/**
 * Make `key` the credential pi authenticates with for `provider`.
 *
 * Writes `auth.json[provider]` (an `api_key` credential) and leaves the other
 * accounts in place. A displaced default whose key is not stored anywhere else
 * in the file is parked in a free `<provider>_<n>` slot instead of being lost,
 * so switching back and forth never drops an account.
 */
export async function setDefaultAccount(options: {
  provider: string;
  key: string;
  account?: string | null;
  preferFile?: string | null;
  home?: string;
}): Promise<SetDefaultResult> {
  const canonical = canonicalAuthProvider(options.provider);
  const home = options.home ?? os.homedir();
  const authFile = pickAuthFile(options.preferFile, home);
  const labeled = tildify(authFile);

  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(authFile, "utf8"));
    if (!isRecord(parsed)) {
      return { ok: false, error: `${labeled} 顶层不是 JSON 对象`, source: labeled, isDefault: false, account: null };
    }
    record = { ...parsed };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      record = {};
    } else {
      return {
        ok: false,
        error: `读取 ${labeled} 失败：${describe(error)}`,
        source: labeled,
        isDefault: false,
        account: null,
      };
    }
  }

  const current = record[canonical];
  const currentKey = credentialKey(current);
  if (currentKey === options.key) {
    return {
      ok: true,
      error: null,
      source: labeled,
      isDefault: true,
      account: credentialAccount(current) ?? options.account ?? null,
    };
  }

  const next: Record<string, unknown> = isRecord(current) ? { ...current } : {};
  // An OAuth entry's fields do not belong on an api_key credential; drop them
  // rather than leaving a half-oauth, half-api-key record behind.
  if (next.type === "oauth") {
    delete next.refresh;
    delete next.access;
    delete next.expires;
  }
  next.type = "api_key";
  next.key = options.key;
  if (options.account) next.account = options.account;
  else delete next.account;
  record[canonical] = next;

  if (currentKey && currentKey !== options.key && !fileHasKey(record, currentKey, canonical)) {
    const previous: Record<string, unknown> = isRecord(current)
      ? { ...current }
      : { type: "api_key", key: currentKey };
    record[freeSlot(record, canonical)] = previous;
  }

  const tmp = `${authFile}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, authFile);
  } catch (error) {
    return {
      ok: false,
      error: `写入 ${labeled} 失败：${describe(error)}`,
      source: labeled,
      isDefault: false,
      account: null,
    };
  }

  console.log(
    `${LOG_PREFIX} usage-set-default: provider=${canonical} account=${options.account ?? "-"} file=${authFile}`,
  );
  return {
    ok: true,
    error: null,
    source: labeled,
    isDefault: true,
    account: options.account ?? null,
  };
}

// ---------------------------------------------------------------------------
// CommandCode adapter (https://api.commandcode.ai)
// ---------------------------------------------------------------------------

interface ParsedCommandCode {
  account: string | null;
  orgId: string | null;
  plan: string | null;
  windows: UsageWindow[];
  metrics: UsageMetric[];
  details: UsageMetric[];
}

function parseCommandCodeWindow(
  entry: unknown,
  key: string,
  label: string,
): UsageWindow | null {
  if (!isRecord(entry)) return null;
  const used = num(entry.used);
  const cap = num(entry.cap);
  if (used === null || cap === null || (used === 0 && cap === 0)) return null;
  const remainingPercent = cap > 0 ? clampPercent(100 * (1 - used / cap)) : null;
  return { key, label, used, cap, remainingPercent, resetAt: resetAtMs(entry.resetAt) };
}

/**
 * CommandCode exposes 5h/weekly limits directly but no monthly window. The
 * monthly window is derived from the remaining monthly credits plus the credits
 * consumed in the current billing period, so the card can draw the same progress
 * bar it draws for 5h/weekly.
 */
function buildCommandCodeMonthlyWindow(
  used: number | null,
  monthlyRemaining: number,
  resetAt: number | null,
): UsageWindow | null {
  const consumed = used ?? 0;
  const cap = monthlyRemaining + consumed;
  if (cap <= 0) return null;
  return {
    key: "monthly",
    label: "月度",
    used: consumed,
    cap,
    remainingPercent: clampPercent(100 * (1 - consumed / cap)),
    resetAt,
  };
}

async function fetchCommandCodeUsage(
  baseUrl: string,
  apiKey: string,
  keySource: string | null,
): Promise<UsageCoreResult> {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { accept: "application/json", authorization: `Bearer ${apiKey}` };
  const provider = "commandcode";

  const who = await fetchJson(`${base}/alpha/whoami`, headers);
  if (!who.ok) {
    const detail = who.text.trim().slice(0, 160);
    return errorResult(
      provider,
      keySource,
      `CommandCode whoami 失败（HTTP ${who.status}）${detail ? `：${detail}` : ""}`,
    );
  }
  const whoBody = isRecord(who.body) ? who.body : {};
  const user = isRecord(whoBody.user) ? whoBody.user : {};
  const org = isRecord(whoBody.org) ? whoBody.org : null;
  const account = str(user.name) ?? str(user.userName) ?? str(user.email);
  const orgId = org ? str(org.id) : null;
  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

  const [credits, subscriptions, summary] = await Promise.all([
    fetchJson(`${base}/alpha/billing/credits${query}`, headers),
    fetchJson(`${base}/alpha/billing/subscriptions${query}`, headers),
    fetchJson(`${base}/alpha/usage/summary${query}`, headers),
  ]);

  const parsed = parseCommandCodePayload({
    credits: credits.ok ? credits.body : null,
    subscriptions: subscriptions.ok ? subscriptions.body : null,
    summary: summary.ok ? summary.body : null,
    account,
    orgId,
  });

  if (parsed.windows.length === 0 && parsed.metrics.length === 0) {
    const status = [credits, subscriptions, summary]
      .filter((r) => !r.ok)
      .map((r) => r.status)
      .join(", ");
    return errorResult(
      provider,
      keySource,
      `CommandCode 未返回可识别的用量数据${status ? `（HTTP ${status}）` : ""}`,
    );
  }

  return {
    ok: true,
    provider,
    fetchedAt: new Date().toISOString(),
    account: parsed.account,
    plan: parsed.plan,
    keySource,
    windows: parsed.windows,
    metrics: parsed.metrics,
    details: parsed.details,
    error: null,
  };
}

/** Exported for tests: turn raw endpoint payloads into a normalized result. */
export function parseCommandCodePayload(input: {
  credits: unknown;
  subscriptions: unknown;
  summary: unknown;
  account: string | null;
  orgId: string | null;
}): ParsedCommandCode {
  const metrics: UsageMetric[] = [];
  const details: UsageMetric[] = [];

  const creditsBody = isRecord(input.credits) ? input.credits : {};
  const credits = isRecord(creditsBody.credits) ? creditsBody.credits : {};
  const monthly = num(credits.monthlyCredits) ?? 0;
  const purchased = num(credits.purchasedCredits) ?? 0;
  const free = num(credits.freeCredits) ?? 0;
  const remaining = monthly + purchased + free;

  const summary = isRecord(input.summary) ? input.summary : {};
  const totalCost = num(summary.totalCost);
  const totalCount = num(summary.totalCount);
  const totalTokens = num(summary.totalTokens) ?? num(summary.tokens);

  const subscriptionBody = isRecord(input.subscriptions) ? input.subscriptions : {};
  const subscription = isRecord(subscriptionBody.data) ? subscriptionBody.data : {};
  const planId = str(subscription.planId) ?? str(subscription.priceId);
  const status = str(subscription.status);
  const plan = planId ? `${planId.replace(/[_-]+/g, " ")}${status ? `（${status}）` : ""}` : null;
  const periodEnd = str(subscription.currentPeriodEnd) ?? num(subscription.currentPeriodEnd);
  const periodEndMs = resetAtMs(periodEnd);

  const windowLimits = isRecord(creditsBody.windowLimits) ? creditsBody.windowLimits : {};
  const windows = [
    parseCommandCodeWindow(windowLimits.fiveHour, "fiveHour", "5 小时"),
    parseCommandCodeWindow(windowLimits.weekly, "weekly", "每周"),
  ].filter((window): window is UsageWindow => window !== null);

  // Prefer an explicitly reported monthly limit; otherwise synthesize one from
  // the monthly credit pool so the detail view still gets a 月度 progress bar.
  const monthlyWindow =
    parseCommandCodeWindow(windowLimits.monthly, "monthly", "月度") ??
    buildCommandCodeMonthlyWindow(
      num(summary.totalMonthlyCredits) ?? totalCost,
      monthly,
      periodEndMs,
    );
  if (monthlyWindow) windows.push(monthlyWindow);

  if (remaining > 0 || totalCost !== null) {
    metrics.push({ label: "剩余", value: `$${remaining.toFixed(2)}` });
  }
  if (totalCost !== null) {
    const pool = remaining + totalCost;
    const percent = pool > 0 ? Math.round((totalCost / pool) * 100) : 0;
    metrics.push({ label: "已用", value: `$${totalCost.toFixed(2)}（${percent}%）` });
  }
  if (totalCount !== null) metrics.push({ label: "请求数", value: totalCount.toLocaleString("en-US") });
  if (totalTokens !== null) metrics.push({ label: "Tokens", value: formatTokens(totalTokens) });

  details.push({ label: "月度额度", value: `$${monthly.toFixed(2)}` });
  details.push({ label: "购买额度", value: `$${purchased.toFixed(2)}` });
  details.push({ label: "赠送额度", value: `$${free.toFixed(2)}` });

  if (periodEndMs) {
    details.push({ label: "当前周期结束", value: new Date(periodEndMs).toLocaleString("zh-CN") });
  }
  if (input.orgId) details.push({ label: "Org", value: input.orgId });

  return { account: input.account, orgId: input.orgId, plan, windows, metrics, details };
}

// ---------------------------------------------------------------------------
// MiniMax adapter (CN + international coding plan)
// ---------------------------------------------------------------------------

const MINIMAX_CN_BASE = "https://www.minimaxi.com";
const MINIMAX_BASE = "https://www.minimax.io";

interface ParsedMinimax {
  windows: UsageWindow[];
  metrics: UsageMetric[];
  details: UsageMetric[];
  error: string | null;
}

/** Exported for tests: normalize a coding_plan/remains response. */
export function parseMinimaxPayload(body: unknown): ParsedMinimax {
  const record = isRecord(body) ? body : {};
  const baseResp = isRecord(record.base_resp) ? record.base_resp : {};
  const statusCode = num(baseResp.status_code);
  if (statusCode !== null && statusCode !== 0) {
    return {
      windows: [],
      metrics: [],
      details: [],
      error: `MiniMax 返回错误 ${statusCode}：${str(baseResp.status_msg) ?? "unknown"}`,
    };
  }

  const models = Array.isArray(record.model_remains)
    ? record.model_remains.filter(isRecord)
    : [];
  if (models.length === 0) {
    return { windows: [], metrics: [], details: [], error: "MiniMax 未返回 model_remains" };
  }

  const primary = models.find((model) => str(model.model_name) === "general") ?? models[0];
  const intervalPercent = num(primary.current_interval_remaining_percent);
  const weeklyPercent = num(primary.current_weekly_remaining_percent);

  const windows: UsageWindow[] = [];
  if (intervalPercent !== null) {
    windows.push({
      key: "interval",
      label: "5 小时",
      used: null,
      cap: null,
      remainingPercent: clampPercent(intervalPercent),
      resetAt: resetAtMs(primary.end_time),
    });
  }
  if (weeklyPercent !== null) {
    windows.push({
      key: "weekly",
      label: "每周",
      used: null,
      cap: null,
      remainingPercent: clampPercent(weeklyPercent),
      resetAt: resetAtMs(primary.weekly_end_time),
    });
  }

  const details: UsageMetric[] = models.map((model) => {
    const name = str(model.model_name) ?? "unknown";
    const interval = num(model.current_interval_remaining_percent);
    const weekly = num(model.current_weekly_remaining_percent);
    return {
      label: name,
      value: `5h ${interval ?? "-"}% · 周 ${weekly ?? "-"}%`,
    };
  });

  const metrics: UsageMetric[] = [{ label: "模型数", value: String(models.length) }];
  const primaryName = str(primary.model_name);
  if (primaryName) metrics.push({ label: "主模型", value: primaryName });

  return { windows, metrics, details, error: null };
}

async function fetchMinimaxUsage(
  provider: string,
  baseUrl: string | null,
  apiKey: string,
  keySource: string | null,
): Promise<UsageCoreResult> {
  const fallback = provider === "minimax-cn" ? MINIMAX_CN_BASE : MINIMAX_BASE;
  const base = (baseUrl ?? fallback).replace(/\/+$/, "");
  const url = `${base}/v1/api/openplatform/coding_plan/remains`;
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  const response = await fetchJson(url, headers);
  if (!response.ok) {
    const detail = response.text.trim().slice(0, 160);
    return errorResult(
      provider,
      keySource,
      `MiniMax 请求失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
    );
  }
  const parsed = parseMinimaxPayload(response.body);
  if (parsed.error) return errorResult(provider, keySource, parsed.error);
  if (parsed.windows.length === 0) {
    return errorResult(provider, keySource, "MiniMax 未返回可识别的用量窗口");
  }

  return {
    ok: true,
    provider,
    fetchedAt: new Date().toISOString(),
    account: null,
    plan: null,
    keySource,
    windows: parsed.windows,
    metrics: parsed.metrics,
    details: parsed.details,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

export async function handleUsageFetch(
  input: RpcInput<typeof usageFetchRpc>,
  _context: PluginHandlerContext,
): Promise<UsageResult> {
  const provider = input.provider.trim();
  const normalized = provider.toLowerCase();
  // A card created by account auto-discovery is pinned to one auth-file slot;
  // otherwise the button's own key source (and pi auto-discovery) wins.
  const discovered = await resolveUsageKey(input);
  const { key, source } = discovered;

  console.log(
    `${LOG_PREFIX} usage-fetch: provider=${provider} keySource=${source ?? "-"} hasKey=${key ? "yes" : "no"}`,
  );

  if (!key) {
    return {
      ...errorResult(
        provider,
        source,
        `未找到 ${provider} 的 API key。已搜索 pi 配置（~/.pi/agent/auth.json 等）；可在卡片「配置」里指定 key / 环境变量 / 文件路径。`,
      ),
      isDefault: null,
      defaultAccount: null,
    };
  }

  // Which of the (possibly several) accounts of this provider pi would use now.
  const status = await readDefaultStatus({ provider, key, preferFile: discovered.file });
  const withDefault = (core: UsageCoreResult): UsageResult => ({
    ...core,
    isDefault: status.isDefault,
    defaultAccount: status.defaultAccount,
  });

  try {
    if (normalized === "commandcode" || normalized === "command-code") {
      return withDefault(
        await fetchCommandCodeUsage(
          input.baseUrl ?? "https://api.commandcode.ai",
          key,
          source,
        ),
      );
    }
    if (normalized === "minimax-cn" || normalized === "minimax" || normalized === "minimax-io") {
      return withDefault(await fetchMinimaxUsage(provider, input.baseUrl, key, source));
    }
    return withDefault(
      errorResult(
        provider,
        source,
        `未知的 usage provider：${provider}（内置：commandcode / minimax-cn / minimax）`,
      ),
    );
  } catch (error) {
    const message = describe(error);
    console.error(`${LOG_PREFIX} usage-fetch: provider=${provider} failed — ${message}`);
    return withDefault(errorResult(provider, source, `请求失败：${message}`));
  }
}

/**
 * Resolve the credential a usage fetch should use: a pinned account slot first,
 * then the button's own apiKey / apiKeyEnv / apiKeyPath, then pi auto-discovery.
 */
async function resolveUsageKey(
  input: RpcInput<typeof usageFetchRpc>,
): Promise<DiscoveredKey> {
  if (input.accountSlot) {
    const slot = await resolveAccountSlot(input.accountSlot);
    if (slot.key) return slot;
  }
  return discoverApiKey({
    provider: input.provider.trim(),
    apiKey: input.apiKey,
    apiKeyEnv: input.apiKeyEnv,
    apiKeyPath: input.apiKeyPath,
  });
}

/** Find a usage button in a project's paseo.json by its index. */
async function readUsageButton(
  projectRoot: string,
  buttonIndex: number,
): Promise<
  | { ok: true; button: Record<string, unknown>; raw: Record<string, unknown>; configPath: string }
  | { ok: false; error: string; configPath: string }
> {
  const configPath = path.join(projectRoot, "paseo.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    return { ok: false, error: `读取 paseo.json 失败：${describe(error)}`, configPath };
  }
  if (!isRecord(raw) || !Array.isArray(raw.buttons)) {
    return { ok: false, error: "paseo.json 里没有 buttons 数组", configPath };
  }
  const button = raw.buttons[buttonIndex];
  if (!isRecord(button)) {
    return { ok: false, error: `paseo.json 里没有第 ${buttonIndex} 个按钮`, configPath };
  }
  if (button.type !== "usage") {
    return { ok: false, error: `第 ${buttonIndex} 个按钮不是 usage 类型`, configPath };
  }
  return { ok: true, button, raw, configPath };
}

/**
 * Switch the provider's default account. When the card is pinned to a slot the
 * slot's key is used; otherwise the button's own key source is resolved exactly
 * like a usage fetch, so the default always matches what the card displays.
 */
export async function handleUsageSetDefault(
  input: RpcInput<typeof usageSetDefaultRpc>,
  _context: PluginHandlerContext,
) {
  const found = await readUsageButton(input.projectRoot, input.buttonIndex);
  if (!found.ok) {
    return { ok: false, error: found.error, isDefault: false, account: null, source: found.configPath };
  }

  const provider = str(found.button.provider) ?? "";
  if (input.accountSlot) {
    const slot = await resolveAccountSlot(input.accountSlot);
    if (!slot.key) {
      return {
        ok: false,
        error: `找不到账号 ${input.accountSlot}（auth.json 里没有这个 key）`,
        isDefault: false,
        account: null,
        source: found.configPath,
      };
    }
    return setDefaultAccount({
      provider,
      key: slot.key,
      account: slot.account,
      preferFile: slot.file,
    });
  }

  const discovered = await discoverApiKey({
    provider,
    apiKey: str(found.button.apiKey),
    apiKeyEnv: str(found.button.apiKeyEnv),
    apiKeyPath: str(found.button.apiKeyPath),
  });
  if (!discovered.key) {
    return {
      ok: false,
      error: `未找到 ${provider || "该按钮"} 的 API key，无法设为默认（检查 apiKeyPath / apiKeyEnv）。`,
      isDefault: false,
      account: null,
      source: found.configPath,
    };
  }

  return setDefaultAccount({
    provider,
    key: discovered.key,
    account: discovered.account,
    preferFile: discovered.file,
  });
}

export async function handleUsageConfigSave(
  input: RpcInput<typeof usageConfigSaveRpc>,
  _context: PluginHandlerContext,
) {
  const found = await readUsageButton(input.projectRoot, input.buttonIndex);
  if (!found.ok) {
    return { ok: false, error: found.error, source: found.configPath };
  }
  const configPath = found.configPath;
  const button = found.button;
  const raw = found.raw;

  const setOrDelete = (field: string, value: string) => {
    const trimmed = value.trim();
    if (trimmed) button[field] = trimmed;
    else delete button[field];
  };
  button.provider = input.provider.trim();
  setOrDelete("apiKey", input.apiKey);
  setOrDelete("apiKeyEnv", input.apiKeyEnv);
  setOrDelete("apiKeyPath", input.apiKeyPath);
  setOrDelete("baseUrl", input.baseUrl);
  button.refreshIntervalMinutes = input.refreshIntervalMinutes;

  const tmp = `${configPath}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await rename(tmp, configPath);
  } catch (error) {
    return { ok: false, error: `写入 paseo.json 失败：${describe(error)}`, source: configPath };
  }

  console.log(
    `${LOG_PREFIX} usage-config-save: buttonIndex=${input.buttonIndex} provider=${input.provider} file=${configPath}`,
  );
  return { ok: true, error: null, source: configPath };
}
