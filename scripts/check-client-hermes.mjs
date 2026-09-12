#!/usr/bin/env node
// Runs the CLIENT bundle inside Hermes — the engine the iOS/Android Paseo app
// uses — instead of Node/V8. Node cannot catch engine-specific breakage, and one
// such breakage is fatal on iPad:
//
//   Paseo evaluates plugin client bundles with `globalThis.eval(...)`. In a large
//   eval'd function, RN's Hermes silently compiles every `class` to `undefined`,
//   so `var store = new RunStore()` throws
//   "TypeError: Cannot read property 'prototype' of undefined" on iOS only.
//   Node, Chrome and Electron (JSC/V8) run the same bundle fine.
//   Functions, closures and object literals are unaffected — so client code must
//   stay class-free. See README "移动端（Hermes）约束".
//
// This script reproduces the app's pipeline as closely as possible:
//   1. bundle index.client.tsx with the daemon's options (esbuild, CJS, es2020,
//      async lowered, Hermes-eager interop, wrapped as a `require` factory),
//   2. bundle shims for the host modules Paseo injects (react, react-native, zod…),
//   3. eval the factory inside `react-native`'s bundled Hermes with `-Xes6-class`,
//   4. run the default export against a mock client context and assert that the
//      workspace panel and the workspace header button were registered.
//
// Usage: node scripts/check-client-hermes.mjs

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

/** Modules the Paseo app injects into plugin client code (0.8 runtime modules). */
const HOST_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-native",
  "zod",
  "@tanstack/react-query",
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
  "@getpaseo/plugin/client/react-native",
];

/** Hermes ships with react-native; the CLI needs `-Xes6-class` to compile classes. */
function resolveHermes() {
  const sdk = path.join(PLUGIN_ROOT, "node_modules", "react-native", "sdks", "hermesc");
  const candidates =
    process.platform === "darwin"
      ? [path.join(sdk, "osx-bin", "hermes")]
      : process.platform === "win32"
        ? [path.join(sdk, "win64-bin", "hermes.exe")]
        : [path.join(sdk, "linux64-bin", "hermes")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Mirrors the daemon's plugin compiler (server/.../plugins/compiler.js). */
function wrapCommonJsBundle(code) {
  return `(function(require) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${code}\nreturn module.exports;\n})`;
}
function makeHermesInteropEager(code) {
  // Hermes evaluates esbuild's lazy CommonJS interop getters from a string with
  // the final loop binding, so every named import can resolve to the last export.
  return code.replaceAll("get: () => from[key]", "value: from[key]");
}

async function buildPluginBundle() {
  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: [path.join(PLUGIN_ROOT, "index.client.tsx")],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    supported: { "async-await": false },
    external: [...HOST_MODULES, "@getpaseo/plugin/server"],
    metafile: true,
    logLevel: "silent",
    treeShaking: true,
    write: false,
  });
  const code = result.outputFiles[0].text;
  return { code, metafile: result.metafile };
}

/** Bundles stand-ins for the host modules so the plugin bundle can be evaluated. */
async function buildHostBundle(outFile) {
  const source = `
const React = require("react");
const jsxRuntime = require("react/jsx-runtime");
const zod = require("zod");
function component(name) {
  const fn = () => null;
  Object.defineProperty(fn, "name", { value: name });
  return fn;
}
const reactNative = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === "Platform") return { OS: "ios", select: (spec) => spec.ios ?? spec.native ?? spec.default };
    if (prop === "StyleSheet") return { create: (styles) => styles, flatten: (style) => style };
    if (prop === "__esModule") return false;
    return component(String(prop));
  },
});
const pluginShared = {
  defineRpc: (definition) => definition,
  defineSettings: (definition) => definition,
  defineAttachmentSource: (definition) => definition,
};
const pluginClient = {
  usePaseo: () => { throw new Error("usePaseo called outside the app"); },
  useRpc: () => () => { throw new Error("useRpc called outside the app"); },
  useWorkspace: () => null,
  useAgent: () => null,
  useSettings: () => ({ status: "loading" }),
};
const pluginReactNative = {
  Icon: component("Icon"),
  Modal: Object.assign(component("Modal"), { Content: component("ModalContent") }),
  useToast: () => ({ show() {}, error() {} }),
  ScrollView: component("ScrollView"),
  FlatList: component("FlatList"),
  TextInput: component("TextInput"),
  copyText: () => Promise.resolve(),
  useRevealedText: (text) => text,
};
globalThis.__hostModules = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-native": reactNative,
  zod,
  "@getpaseo/plugin": pluginShared,
  "@getpaseo/plugin/client": pluginClient,
  "@getpaseo/plugin/client/ui": pluginClient,
  "@getpaseo/plugin/client/react-native": pluginReactNative,
  "@tanstack/react-query": { QueryClient: class QueryClient {}, useQuery: () => ({}) },
};
`;
  const result = await build({
    stdin: { contents: source, resolveDir: PLUGIN_ROOT, sourcefile: "host-shim.js", loader: "js" },
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2020",
    supported: { "async-await": false },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    write: false,
  });
  writeFileSync(outFile, result.outputFiles[0].text);
}

/**
 * Runs inside Hermes: evaluates the bundle exactly like the app does and reports
 * one machine-readable line per phase.
 */
const RUNNER = String.raw`
var out = [];
function say(line) { out.push(line); }
function req(name) {
  var mods = globalThis.__hostModules;
  if (Object.prototype.hasOwnProperty.call(mods, name)) return mods[name];
  throw new Error('Module "' + name + '" is not available in plugin client code');
}

var registry = { workspacePanels: [], commandCenterItems: [], headerButtons: [] };
function reg(bucket, entry) { registry[bucket].push(entry); return { update: function () {}, remove: function () {} }; }
function context() {
  var workspaceId = "wks_hermes";
  return {
    addWorkspacePanel: function (c) { return reg("workspacePanels", c); },
    addCommandCenterItem: function (c) { return reg("commandCenterItems", c); },
    addHeaderButton: function (args) { return reg("headerButtons", args); },
    addSurface: function () { return { update: function () {}, remove: function () {} }; },
    addSidebarItem: function () { return { update: function () {}, remove: function () {} }; },
    addSlashCommand: function () { return { update: function () {}, remove: function () {} }; },
    addAttachmentSource: function () { return { update: function () {}, remove: function () {} }; },
    addTheme: function () { return { update: function () {}, remove: function () {} }; },
    addSettingsScreen: function () { return { update: function () {}, remove: function () {} }; },
    addTimelineTransformer: function () { return { update: function () {}, remove: function () {} }; },
    addTimelineRenderer: function () { return { update: function () {}, remove: function () {} }; },
    addComposerPill: function (args) { return reg("headerButtons", args); },
    openPanel: function () {},
    openSettings: function () {},
    openSurface: function () {},
    rpc: function (contract, input) {
      if (contract && contract.name === "paseo-topbar-command.load-config") {
        return Promise.resolve({
          buttons: [{ type: "script", id: "typecheck", label: "类型检查", command: "pnpm typecheck" }],
          source: input.projectRoot + "/paseo.json",
          exists: true,
          error: null,
        });
      }
      return Promise.reject(new Error("unexpected rpc " + (contract && contract.name)));
    },
    paseo: {
      workspaces: {
        list: function () {
          return Promise.resolve({
            requestId: "req_hermes",
            entries: [{
              id: workspaceId,
              projectId: "proj_hermes",
              projectDisplayName: "plugin",
              projectRootPath: "/tmp/plugin",
              workspaceDirectory: "/tmp/plugin",
              projectKind: "directory",
              workspaceKind: "directory",
              name: "plugin",
              title: null,
              status: "done",
              statusEnteredAt: null,
              archivingAt: null,
              diffStat: null,
            }],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          });
        },
        subscribe: function () { return function () {}; },
      },
    },
  };
}

// The Hermes CLI has neither a console nor timers; the app has both. Stub them
// so plugin init can finish and its logging does not abort the run.
if (typeof console === "undefined") {
  var logLine = function (message) { say("LOG " + String(message)); };
  globalThis.console = { log: logLine, warn: logLine, error: logLine, info: logLine, debug: logLine };
}
if (typeof setInterval === "undefined") globalThis.setInterval = function () { return 0; };
if (typeof clearInterval === "undefined") globalThis.clearInterval = function () {};
if (typeof setTimeout === "undefined") globalThis.setTimeout = function () { return 0; };
if (typeof clearTimeout === "undefined") globalThis.clearTimeout = function () {};

say("ENGINE " + (typeof globalThis.HermesInternal === "undefined" ? "jsc" : "hermes"));
var factory;
try {
  factory = (0, globalThis.eval)(PLUGIN_SRC);
} catch (error) {
  say("EVAL_FAILED " + String(error));
  throw error;
}
say("EVAL_OK " + typeof factory);
var exports = factory(req);
var contribute = exports && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
say("EXPORT " + typeof contribute);
var cleanup;
try {
  cleanup = contribute(context());
} catch (error) {
  say("SETUP_FAILED " + String(error));
  throw error;
}
say("SETUP_OK cleanup=" + typeof cleanup);

// Let the async workspace bootstrap settle (Promise jobs only, no timers).
var hops = 0;
function settle() {
  hops += 1;
  if (hops < 60) { Promise.resolve().then(settle); return; }
  say("PANELS " + registry.workspacePanels.length);
  say("COMMANDS " + registry.commandCenterItems.length);
  say("BUTTONS " + registry.headerButtons.length);
  var button = registry.headerButtons[0];
  say("MENU " + (button && button.button && button.button.behavior && button.button.behavior.kind === "menu"
    ? button.button.behavior.items.length : -1));
  for (var i = 0; i < out.length; i += 1) print("HERMES_RESULT " + out[i]);
}
Promise.resolve().then(settle);
`;

function main() {
  const hermes = resolveHermes();
  if (!hermes) {
    console.log("Hermes binary not found (node_modules/react-native/sdks/hermesc); skipping.");
    console.log("Run `npm install` first. This check is the only one that can catch iOS-only crashes.");
    return 0;
  }

  return (async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "paseo-plugin-hermes-"));
    const { code, metafile } = await buildPluginBundle();

    // Any `class` in the client bundle is a latent iPad crash: see the header.
    const classHits = code
      .split("\n")
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => /\bclass\s*[{A-Za-z_$]/.test(line) || /=\s*class\b/.test(line));
    const hostFile = path.join(tmp, "host.js");
    await buildHostBundle(hostFile);
    const runFile = path.join(tmp, "run.js");
    writeFileSync(
      runFile,
      [
        (await import("node:fs")).readFileSync(hostFile, "utf8"),
        `var PLUGIN_SRC = ${JSON.stringify(wrapCommonJsBundle(makeHermesInteropEager(code)))};`,
        RUNNER,
      ].join("\n"),
    );

    console.log(`plugin dir:  ${PLUGIN_ROOT}`);
    console.log(`engine:      ${hermes}`);
    console.log(`bundle:      ${code.length} bytes`);
    const inputs = Object.keys(metafile.inputs).length;
    console.log(`inputs:      ${inputs} files\n`);

    const result = spawnSync(hermes, ["-Xes6-class", "-exec", runFile], { encoding: "utf8" });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const phases = new Map(
      output
        .split("\n")
        .filter((line) => line.startsWith("HERMES_RESULT "))
        .map((line) => {
          const [key, ...rest] = line.slice("HERMES_RESULT ".length).split(" ");
          return [key, rest.join(" ")];
        }),
    );

    // Non-fatal Hermes warnings are printed as `file:line: warning:`; show engine errors only.
    const engineErrors = output
      .split("\n")
      .filter((line) => /error:/.test(line) || /Uncaught|TypeError|ReferenceError|SyntaxError/.test(line))
      .slice(0, 6);
    for (const line of engineErrors) console.log(`  ${line.trim()}`);

    const report = [
      ["bundle eval", phases.get("EVAL_OK") === "function", phases.get("EVAL_OK") ?? phases.get("EVAL_FAILED")],
      ["default export", phases.get("EXPORT") === "function", phases.get("EXPORT")],
      ["contribute()", phases.get("SETUP_OK")?.startsWith("cleanup=function") === true, phases.get("SETUP_OK") ?? phases.get("SETUP_FAILED")],
      ["workspace panel", phases.get("PANELS") === "1", phases.get("PANELS")],
      ["command center item", phases.get("COMMANDS") === "1", phases.get("COMMANDS")],
      ["workspace header button", phases.get("BUTTONS") === "1", phases.get("BUTTONS")],
      ["header menu items", Number(phases.get("MENU") ?? -1) > 0, phases.get("MENU")],
    ];
    for (const [label, ok, detail] of report) {
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(22)} ${detail ?? "(no result)"}`);
    }

    if (classHits.length > 0) {
      console.log(`\nWARNING: the client bundle contains class syntax, which Hermes mis-compiles in eval:`);
      for (const hit of classHits.slice(0, 8)) {
        console.log(`  bundle.js:${hit.index}  ${hit.line.trim().slice(0, 90)}`);
      }
      console.log("  Client code must stay class-free (functions/closures/objects instead).");
    }

    const failed = report.filter(([, ok]) => !ok);
    if (failed.length > 0) {
      console.log("\nRESULT: client bundle does not run under Hermes — the iOS/iPad app would crash.");
      return 1;
    }
    console.log("\nRESULT: client bundle evaluates and registers its contributions under Hermes.");
    if (classHits.length > 0) return 1;
    return 0;
  })();
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`\nHermes client check FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
