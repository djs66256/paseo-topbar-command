#!/usr/bin/env node
// End-to-end smoke test against a running Paseo daemon. It speaks the daemon
// WebSocket protocol directly and invokes this plugin's registered RPC methods,
// so it exercises the real daemon-side code without the Paseo UI.
//
// Usage:
//   node scripts/rpc-smoke.mjs [--project <root>] [--run "<shell command>"] [--url <ws-url>]
//
// Examples:
//   node scripts/rpc-smoke.mjs --project ~/Documents/github/xiuxian
//   node scripts/rpc-smoke.mjs --project /tmp/demo --run "echo hello && sleep 1"
//
// Default URL: ws://127.0.0.1:6767/ws (override with --url or PASEO_WS).
const PLUGIN_ID = "paseo-topbar-command";
const LOAD_CONFIG = `${PLUGIN_ID}.load-config`;
const SCRIPT_START = `${PLUGIN_ID}.script-start`;
const SCRIPT_POLL = `${PLUGIN_ID}.script-poll`;

function parseArgs(argv) {
  const args = { project: process.cwd(), run: null, url: process.env.PASEO_WS ?? "ws://127.0.0.1:6767/ws" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") args.project = argv[++i];
    else if (arg === "--run") args.run = argv[++i];
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "-h" || arg === "--help") {
      console.log("usage: node scripts/rpc-smoke.mjs [--project <root>] [--run \"<command>\"] [--url <ws-url>]");
      process.exit(0);
    }
  }
  return args;
}

/** Minimal daemon session client over WebSocket. */
class DaemonRpc {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.waiters = new Map();
    this.connected = Promise.withResolvers();
    this.serverInfo = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => this.#onMessage(event));
    this.ws.addEventListener("error", () => {
      this.connected.reject(new Error(`cannot connect to ${this.url} — is the Paseo daemon running?`));
    });
    this.ws.addEventListener("open", () => {
      this.ws.send(
        JSON.stringify({ type: "hello", clientId: "plugin-e2e-smoke", clientType: "cli", protocolVersion: 1 }),
      );
    });
    return this.connected.promise;
  }

  #onMessage(event) {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    const message = parsed?.message ?? parsed;
    if (message?.type === "server_info") {
      this.serverInfo = message;
      this.connected.resolve();
      return;
    }
    const requestId = message?.payload?.requestId;
    if (requestId && this.waiters.has(requestId)) {
      const { resolve, reject } = this.waiters.get(requestId);
      this.waiters.delete(requestId);
      if (message.type === "rpc_error") reject(new Error(JSON.stringify(message.payload)));
      else resolve(message.payload);
    }
  }

  invoke(method, input, timeoutMs = 15_000) {
    const requestId = crypto.randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers();
    this.waiters.set(requestId, { resolve, reject });
    const timer = setTimeout(() => {
      this.waiters.delete(requestId);
      reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    void promise.finally(() => clearTimeout(timer));
    this.ws.send(
      JSON.stringify({
        type: "session",
        message: { type: "plugin.rpc.invoke.request", requestId, pluginId: PLUGIN_ID, method, input },
      }),
    );
    return promise.then((payload) => payload.output);
  }

  close() {
    this.ws?.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = new DaemonRpc(args.url);
  await client.connect();
  console.log(`connected: ${args.url}`);
  console.log(`project:   ${args.project}\n`);

  const config = await client.invoke(LOAD_CONFIG, { projectRoot: args.project });
  console.log(`load-config → ${config.buttons.length} button(s), error=${config.error ?? "none"}`);
  for (const button of config.buttons) {
    console.log(`  - [${button.type}] ${button.label}${button.type === "script" ? ` → ${button.command}` : ` → ${button.app}`}`);
  }

  if (args.run) {
    const jobId = `smoke-${Date.now()}`;
    console.log(`\nscript-start → ${JSON.stringify(args.run)}`);
    const started = await client.invoke(SCRIPT_START, {
      jobId,
      command: args.run,
      projectRoot: args.project,
      cwd: "",
    });
    if (!started.ok) throw new Error(`script-start failed: ${started.error}`);

    let result;
    for (let i = 0; i < 300; i += 1) {
      result = await client.invoke(SCRIPT_POLL, { jobId });
      if (result.status !== "running") break;
      await sleep(100);
    }
    console.log(`script-poll → status=${result.status} exitCode=${result.exitCode}`);
    if (result.output.length > 0) console.log(result.output.map((line) => `  | ${line}`).join("\n"));
    if (result.status !== "succeeded") throw new Error(`script did not succeed (${result.status})`);
  }

  client.close();
  console.log("\nsmoke OK");
}

main().catch((error) => {
  console.error(`\nsmoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
