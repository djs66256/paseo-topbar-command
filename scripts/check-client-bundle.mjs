#!/usr/bin/env node
// Verifies the CLIENT half of the plugin without the app: it fetches the
// daemon-compiled client bundle from the plugin catalog, evaluates it with the
// same module shims the Paseo app uses, runs the default export against a mock
// plugin context, and prints every contribution that got registered.
//
// If this prints a `workspacePanels` entry, the client bundle is healthy and the
// "I can't see it" problem is UI navigation / app refresh, not the plugin.
//
// Usage: node scripts/check-client-bundle.mjs [--url <ws-url>] [--id paseo-topbar-command]
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PLUGIN_ID = "paseo-topbar-command";

function parseArgs(argv) {
  const args = { url: process.env.PASEO_WS ?? "ws://127.0.0.1:6767/ws", id: PLUGIN_ID };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url") args.url = argv[++i];
    else if (argv[i] === "--id") args.id = argv[++i];
  }
  return args;
}

function fetchCatalog(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => reject(new Error("timed out talking to daemon")), 8000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "hello", clientId: "plugin-client-check", clientType: "cli", protocolVersion: 1 })),
    );
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data)?.message;
      } catch {
        return;
      }
      if (message?.type === "status") {
        ws.send(JSON.stringify({ type: "session", message: { type: "plugin.catalog.get.request", requestId } }));
        return;
      }
      if (message?.type === "plugin.catalog.get.response" && message.payload?.requestId === requestId) {
        clearTimeout(timer);
        ws.close();
        resolve(message.payload.plugins ?? []);
      }
      if (message?.type === "rpc_error") {
        clearTimeout(timer);
        reject(new Error(JSON.stringify(message.payload)));
      }
    });
  });
}

/** Minimal stand-ins for the modules the app injects into plugin client code. */
function createModuleShims() {
  const react = require("react");
  const zod = require("zod");

  const component = (name) => {
    const fn = () => null;
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  };
  // react-native is only touched at render time; a proxy is enough to register.
  const reactNative = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "__esModule") return true;
        if (prop === "StyleSheet") return { create: (styles) => styles, flatten: (s) => s };
        return component(String(prop));
      },
    },
  );

  const pluginShim = {
    defineRpc: (definition) => definition,
    defineAttachmentSource: (definition) => definition,
    useRpc: () => () => Promise.resolve(null),
    useWorkspace: () => null,
    useAgent: () => null,
    usePaseo: () => ({}),
    Icon: () => null,
  };

  return (specifier) => {
    if (specifier === "react") return react;
    if (specifier === "react/jsx-runtime") return require("react/jsx-runtime");
    if (specifier === "react-native") return reactNative;
    if (specifier === "@getpaseo/plugin") return pluginShim;
    if (specifier === "@getpaseo/plugin/server") {
      return { defineRpc: pluginShim.defineRpc, defineAttachmentSource: pluginShim.defineAttachmentSource };
    }
    if (specifier === "@tanstack/react-query") return require("@tanstack/react-query");
    if (specifier === "zod") return zod;
    throw new Error(`Module "${specifier}" is not available in plugin client code`);
  };
}

function mockPluginContext() {
  const seen = { surfaces: [], sidebarItems: [], workspacePanels: [], commandCenterItems: [], clientSide: null, attachmentSources: [], themes: [] };
  const context = {
    addSurface: (id, Component) => seen.surfaces.push({ id, isComponent: typeof Component === "function" }),
    addSidebarItem: (item) => seen.sidebarItems.push(item),
    addWorkspacePanel: (panel) => {
      if (typeof panel.Component !== "function") throw new Error(`panel ${panel.id} Component is not a function`);
      seen.workspacePanels.push({ id: panel.id, title: panel.title, icon: panel.icon, context: panel.context, locations: panel.locations });
    },
    addCommandCenterItem: (item) => seen.commandCenterItems.push({ id: item.id, title: item.title, context: item.context, keywords: item.keywords }),
    addClientSide: (fn) => (seen.clientSide = typeof fn),
    addAttachmentSource: (source) => seen.attachmentSources.push(source),
    addTheme: (theme) => seen.themes.push(theme),
  };
  return { seen, context };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plugins = await fetchCatalog(args.url);
  const plugin = plugins.find((entry) => entry.id === args.id);
  if (!plugin) throw new Error(`plugin ${args.id} is not in the daemon catalog (install/enable it first)`);

  console.log(`catalog entry: ${args.id}`);
  console.log(`  has clientBundle: ${typeof plugin.clientBundle === "string" && plugin.clientBundle.length > 0}`);
  console.log(`  keys: ${Object.keys(plugin).join(", ")}\n`);

  const factory = globalThis.eval(plugin.clientBundle);
  if (typeof factory !== "function") throw new Error("client bundle did not evaluate to a function");
  const moduleExports = factory(createModuleShims());
  const contribute = moduleExports?.default;
  if (typeof contribute !== "function") throw new Error("client bundle has no default export");

  const { seen, context } = mockPluginContext();
  const cleanup = contribute(context);

  const total =
    seen.surfaces.length +
    seen.sidebarItems.length +
    seen.workspacePanels.length +
    seen.commandCenterItems.length +
    seen.attachmentSources.length +
    seen.themes.length +
    (seen.clientSide ? 1 : 0);

  console.log(`registered contributions: ${total}`);
  console.log(JSON.stringify(seen, null, 2));
  console.log(`cleanup function returned: ${typeof cleanup === "function"}`);

  if (seen.workspacePanels.length === 0 && seen.commandCenterItems.length === 0) {
    console.log("\nRESULT: no workspace panel and no command item — the client bundle would show nothing.");
    process.exit(1);
  }
  console.log("\nRESULT: client bundle registers the panel; the plugin code is fine. Look at the UI/app refresh.");
}

main().catch((error) => {
  console.error(`\nclient bundle check FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
