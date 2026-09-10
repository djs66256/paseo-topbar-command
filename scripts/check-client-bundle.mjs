#!/usr/bin/env node
// Verifies the CLIENT half of the plugin without the Paseo app: it bundles
// index.client.tsx with esbuild (the same entry the app evaluates), injects the
// host modules Paseo provides, runs the default export against a mock 0.8 client
// context, and prints every contribution that got registered.
//
// The mock context answers `load-config` from the real filesystem, so a header
// button only shows up here if the whole path works: workspace enumeration ->
// per-project config read -> addHeaderButton. If this prints a header button and
// a workspace panel, the client bundle is healthy and any "I can't see it"
// problem is app-side (host selection, refresh, header overflow).
//
// Usage: node scripts/check-client-bundle.mjs [--project <root>] [--json]
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const PLUGIN_ID = "paseo-topbar-command";

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

function parseArgs(argv) {
  const args = { project: PLUGIN_ROOT, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--project") args.project = path.resolve(argv[++i]);
    else if (argv[i] === "--json") args.json = true;
  }
  return args;
}

/** Minimal stand-ins for the host modules. Components must be valid element types. */
async function createModuleShims() {
  const react = await import("react");
  const zod = await import("zod");

  const component = (name) => {
    const fn = () => null;
    Object.defineProperty(fn, "name", { value: name });
    return fn;
  };
  // react-native is only touched while rendering; a proxy is enough to register.
  const reactNative = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "Platform") return { OS: "web", select: (spec) => spec.web ?? spec.default };
        if (prop === "StyleSheet") return { create: (styles) => styles, flatten: (style) => style };
        if (prop === "__esModule") return false;
        return component(String(prop));
      },
    },
  );

  const pluginRoot = {
    defineRpc: (definition) => definition,
    defineSettings: (definition) => definition,
    defineAttachmentSource: (definition) => definition,
  };
  const pluginClient = {
    usePaseo: () => {
      throw new Error("usePaseo called outside the app");
    },
    useRpc: () => () => {
      throw new Error("useRpc called outside the app");
    },
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
    copyText: async () => {},
    useRevealedText: (text) => text,
  };

  return (specifier) => {
    switch (specifier) {
      case "react":
        return react;
      case "react/jsx-runtime":
        return react;
      case "react-native":
        return reactNative;
      case "zod":
        return zod;
      case "@tanstack/react-query":
        return { QueryClient: class QueryClient {}, useQuery: () => ({}) };
      case "@getpaseo/plugin":
        return pluginRoot;
      case "@getpaseo/plugin/client":
      case "@getpaseo/plugin/client/ui":
        return pluginClient;
      case "@getpaseo/plugin/client/react-native":
        return pluginReactNative;
      default:
        throw new Error(`Module "${specifier}" is not available in plugin client code`);
    }
  };
}

/** Records every contribution and answers RPC from the real project directory. */
function mockClientContext(projectRoot) {
  const seen = {
    workspacePanels: [],
    commandCenterItems: [],
    headerButtons: [],
    composerPills: [],
    surfaces: [],
    sidebarItems: [],
    slashCommands: [],
    attachmentSources: [],
    themes: [],
    settingsScreens: [],
    timelineTransformers: [],
    timelineRenderers: [],
    openPanels: [],
  };
  const workspaceId = "wks_smoke";

  const registration = (bucket, entry) => {
    seen[bucket].push(entry);
    return { update() {}, remove() {} };
  };

  const context = {
    addWorkspacePanel: (contribution) => registration("workspacePanels", contribution),
    addCommandCenterItem: (contribution) => registration("commandCenterItems", contribution),
    addSurface: (id, Component) => registration("surfaces", { id, Component }),
    addSidebarItem: (contribution) => registration("sidebarItems", contribution),
    addSlashCommand: (contribution) => registration("slashCommands", contribution),
    addAttachmentSource: (contribution) => registration("attachmentSources", contribution),
    addTheme: (contribution) => registration("themes", contribution),
    addSettingsScreen: (contribution) => registration("settingsScreens", contribution),
    addTimelineTransformer: (contribution) => registration("timelineTransformers", contribution),
    addTimelineRenderer: (contribution) => registration("timelineRenderers", contribution),
    addHeaderButton: ({ id, workspaceId: target, button }) =>
      registration("headerButtons", { id, workspaceId: target, button }),
    addComposerPill: ({ id, workspaceId: target, agentId, button }) =>
      registration("composerPills", { id, workspaceId: target, agentId, button }),
    openPanel: (id, options) => seen.openPanels.push({ id, options }),
    openSettings: (id) => seen.openPanels.push({ id, settings: true }),
    async rpc(contract, input) {
      if (contract?.name === `${PLUGIN_ID}.load-config`) {
        const file = path.join(input.projectRoot, "paseo.json");
        let buttons = [];
        let error = null;
        let exists = true;
        try {
          const parsed = JSON.parse(await readFile(file, "utf8"));
          buttons = Array.isArray(parsed?.buttons) ? parsed.buttons : [];
        } catch (readError) {
          if (readError?.code === "ENOENT") {
            exists = false;
            error = `未找到配置文件：${file}`;
          } else {
            error = String(readError);
          }
        }
        return { buttons, source: file, exists, error };
      }
      throw new Error(`unexpected RPC in client check: ${contract?.name ?? contract}`);
    },
    paseo: {
      workspaces: {
        async list() {
          return {
            requestId: "req_smoke",
            entries: [
              {
                id: workspaceId,
                projectId: "proj_smoke",
                projectDisplayName: path.basename(projectRoot),
                projectRootPath: projectRoot,
                workspaceDirectory: projectRoot,
                projectKind: "directory",
                workspaceKind: "directory",
                name: path.basename(projectRoot),
                title: null,
                status: "done",
                statusEnteredAt: null,
                archivingAt: null,
                diffStat: null,
              },
            ],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          };
        },
        subscribe() {
          return () => {};
        },
      },
    },
  };

  return { seen, context, workspaceId };
}

function describeMenu(button) {
  if (button?.behavior?.kind !== "menu") return button?.behavior?.kind ?? "?";
  return button.behavior.items
    .filter((item) => item.kind === "item")
    .map((item) => (item.disabled ? `(${item.title})` : item.title))
    .join(" | ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`plugin dir: ${PLUGIN_ROOT}`);
  console.log(`project:    ${args.project}\n`);

  const result = await build({
    absWorkingDir: PLUGIN_ROOT,
    entryPoints: ["index.client.tsx"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    jsx: "automatic",
    logLevel: "silent",
    external: HOST_MODULES,
  });
  const code = result.outputFiles[0].text;
  console.log(`bundled index.client.tsx: ${code.length} bytes`);

  // Paseo evaluates the client bundle as a factory that receives the host modules.
  const factory = new Function("require", "module", "exports", code);
  const module = { exports: {} };
  factory(await createModuleShims(), module, module.exports);
  const contribute = module.exports?.default;
  if (typeof contribute !== "function") throw new Error("client bundle has no default export");

  const { seen, context, workspaceId } = mockClientContext(args.project);
  const cleanup = contribute(context);

  // The entry enumerates workspaces asynchronously, so let those promises settle.
  await new Promise((resolve) => setTimeout(resolve, 500));

  console.log(`\nregistered: workspacePanels=${seen.workspacePanels.length} commandCenterItems=${seen.commandCenterItems.length} headerButtons=${seen.headerButtons.length}`);
  for (const panel of seen.workspacePanels) {
    console.log(`  panel ${panel.id}: ${panel.title} [${panel.context}] locations=${(panel.locations ?? []).join("+")}`);
  }
  for (const item of seen.commandCenterItems) {
    console.log(`  command ${item.id}: ${item.title} [${item.context}]`);
  }
  for (const entry of seen.headerButtons) {
    console.log(`  header button ${entry.id} (${entry.workspaceId}): ${entry.button.title}`);
    console.log(`    menu: ${describeMenu(entry.button)}`);
    console.log(`    icon: ${typeof entry.button.icon === "string" ? entry.button.icon : "component"}`);
  }
  console.log(`  cleanup returned: ${typeof cleanup}`);
  if (args.json) console.log(JSON.stringify(seen, null, 2));

  cleanup();

  const hasHeader = seen.headerButtons.some((entry) => entry.workspaceId === workspaceId);
  if (seen.workspacePanels.length === 0 && seen.commandCenterItems.length === 0) {
    console.log("\nRESULT: no workspace panel and no command item — the client bundle would show nothing.");
    process.exit(1);
  }
  if (!hasHeader) {
    console.log(
      "\nRESULT: panel registered but no header button — the project has no paseo.json, or the header path regressed.",
    );
    process.exit(1);
  }
  console.log("\nRESULT: client bundle registers the panel and the workspace header button.");
}

main().catch((error) => {
  console.error(`\nclient bundle check FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
