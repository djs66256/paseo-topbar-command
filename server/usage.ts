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
import { usageConfigSaveRpc, usageFetchRpc } from "../shared/rpc";

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

/** Normalize a reset timestamp to epoch milliseconds. */
function resetAtMs(value: unknown): number | null {
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

function errorResult(provider: string, keySource: string | null, message: string): UsageResult {
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

/** Search one parsed JSON document for a provider's credential. */
export function searchProvider(
  record: Record<string, unknown>,
  aliases: readonly string[],
): { key: string; pointer: string } | null {
  for (const alias of aliases) {
    const found = credentialKey(record[alias]);
    if (found) return { key: found, pointer: alias };
  }
  const topLevel = credentialKey(record.apiKey);
  if (topLevel) return { key: topLevel, pointer: "apiKey" };
  if (isRecord(record.providers)) {
    for (const alias of aliases) {
      const entry = record.providers[alias];
      if (!isRecord(entry)) continue;
      const found = credentialKey(entry.apiKey) ?? credentialKey(entry);
      if (found) return { key: found, pointer: `providers.${alias}.apiKey` };
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
  if (inline) return { key: inline, source: "paseo.json（inline apiKey）" };

  const env = options.env ?? process.env;
  const envNames = [
    ...(options.apiKeyEnv?.trim() ? [options.apiKeyEnv.trim()] : []),
    ...(PROVIDER_ENV[options.provider.trim().toLowerCase()] ?? []),
  ];
  for (const name of envNames) {
    const value = env[name];
    if (value && value.trim()) return { key: value.trim(), source: `env:${name}` };
  }

  if (options.apiKeyPath?.trim()) {
    const spec = options.apiKeyPath.trim();
    const { file, pointer } = splitKeyPath(spec);
    const json = await readJsonFile(expandHome(file));
    if (json !== null) {
      const value = pointer ? walkPointer(json, pointer) : json;
      const key = credentialKey(value);
      if (key) return { key, source: spec };
    }
  }

  const home = options.home ?? os.homedir();
  const aliases = providerAliases(options.provider);
  for (const file of keyFileCandidates(home)) {
    const json = await readJsonFile(file);
    if (!isRecord(json)) continue;
    const found = searchProvider(json, aliases);
    if (found) return { key: found.key, source: `${tildify(file)}#${found.pointer}` };
  }

  return { key: null, source: null };
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

async function fetchCommandCodeUsage(
  baseUrl: string,
  apiKey: string,
  keySource: string | null,
): Promise<UsageResult> {
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

  const windowLimits = isRecord(creditsBody.windowLimits) ? creditsBody.windowLimits : {};
  const windows = [
    parseCommandCodeWindow(windowLimits.fiveHour, "fiveHour", "5 小时"),
    parseCommandCodeWindow(windowLimits.weekly, "weekly", "每周"),
  ].filter((window): window is UsageWindow => window !== null);

  const summary = isRecord(input.summary) ? input.summary : {};
  const totalCost = num(summary.totalCost);
  const totalCount = num(summary.totalCount);
  const totalTokens = num(summary.totalTokens) ?? num(summary.tokens);

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

  const subscriptionBody = isRecord(input.subscriptions) ? input.subscriptions : {};
  const subscription = isRecord(subscriptionBody.data) ? subscriptionBody.data : {};
  const planId = str(subscription.planId) ?? str(subscription.priceId);
  const status = str(subscription.status);
  const plan = planId ? `${planId.replace(/[_-]+/g, " ")}${status ? `（${status}）` : ""}` : null;
  const periodEnd = str(subscription.currentPeriodEnd) ?? num(subscription.currentPeriodEnd);
  const periodEndMs = resetAtMs(periodEnd);
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
): Promise<UsageResult> {
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
  const { key, source } = await discoverApiKey({
    provider,
    apiKey: input.apiKey,
    apiKeyEnv: input.apiKeyEnv,
    apiKeyPath: input.apiKeyPath,
  });

  console.log(
    `${LOG_PREFIX} usage-fetch: provider=${provider} keySource=${source ?? "-"} hasKey=${key ? "yes" : "no"}`,
  );

  if (!key) {
    return errorResult(
      provider,
      source,
      `未找到 ${provider} 的 API key。已搜索 pi 配置（~/.pi/agent/auth.json 等）；可在卡片「配置」里指定 key / 环境变量 / 文件路径。`,
    );
  }

  try {
    if (normalized === "commandcode" || normalized === "command-code") {
      return await fetchCommandCodeUsage(
        input.baseUrl ?? "https://api.commandcode.ai",
        key,
        source,
      );
    }
    if (normalized === "minimax-cn" || normalized === "minimax" || normalized === "minimax-io") {
      return await fetchMinimaxUsage(provider, input.baseUrl, key, source);
    }
    return errorResult(
      provider,
      source,
      `未知的 usage provider：${provider}（内置：commandcode / minimax-cn / minimax）`,
    );
  } catch (error) {
    const message = describe(error);
    console.error(`${LOG_PREFIX} usage-fetch: provider=${provider} failed — ${message}`);
    return errorResult(provider, source, `请求失败：${message}`);
  }
}

export async function handleUsageConfigSave(
  input: RpcInput<typeof usageConfigSaveRpc>,
  _context: PluginHandlerContext,
) {
  const configPath = path.join(input.projectRoot, "paseo.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    return { ok: false, error: `读取 paseo.json 失败：${describe(error)}`, source: configPath };
  }
  if (!isRecord(raw) || !Array.isArray(raw.buttons)) {
    return { ok: false, error: "paseo.json 里没有 buttons 数组", source: configPath };
  }

  const buttons = raw.buttons as unknown[];
  const button = buttons.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry.id === input.buttonId,
  );
  if (!button) {
    return { ok: false, error: `找不到按钮 ${input.buttonId}`, source: configPath };
  }
  if (button.type !== "usage") {
    return { ok: false, error: `按钮 ${input.buttonId} 不是 usage 类型`, source: configPath };
  }

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
    `${LOG_PREFIX} usage-config-save: button=${input.buttonId} provider=${input.provider} file=${configPath}`,
  );
  return { ok: true, error: null, source: configPath };
}
