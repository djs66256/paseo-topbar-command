// Client entry (Paseo 0.8 runtime entry). Contributes three things per connected app:
//
//  1. Two workspace header buttons per tracked workspace, emulating a split
//     button: the left repeats the last clicked tool as a one-click action, the
//     right opens a menu of that project's paseo.json buttons plus usage, run
//     status, the panel, and a config reload. Paseo has no split-button
//     primitive, so these are two registrations; a project without a paseo.json
//     gets no buttons.
//  2. The Commands workspace panel, which shows full status, output and usage.
//  3. A Command Center item that opens that panel.
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { CommandsPanel } from "./client/commands";
import {
  COMMANDS_PANEL_ID,
  HEADER_BUTTON_ID,
  RUN_BUTTON_ID,
  createHeaderMenu,
  createRunButton,
} from "./client/header";
import { clearWorkspaceRefresher, setWorkspaceRefresher } from "./client/refresh-bus";
import { configureRuns } from "./client/run-store";
import { configureLastUsed, lastUsedStore } from "./client/last-used";
import { configureUsage, usageStore } from "./client/usage-store";
import { resolvePanelLocations, type ButtonConfig } from "./shared/config";
// Panel locations are plugin-level (Paseo registers them once at load). The file
// lives under client/ because 0.8 only allows modules in client/, server/ or
// shared/ — a root-level file that is imported is a build error.
import pluginConfig from "./client/plugin.config.json";
import {
  lastUsedGetRpc,
  lastUsedSetRpc,
  loadConfigRpc,
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
  usageConfigSaveRpc,
  usageFetchRpc,
  usageSetDefaultRpc,
} from "./shared/rpc";

const LOG_PREFIX = "[paseo-topbar-command]";
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 5000;
/**
 * Paseo 0.9+ assigns observation ids itself: passing
 * `subscribe: { subscriptionId }` throws "Subscription IDs are assigned by the
 * host", which used to fail bootstrap and hide every header button.
 * `subscribe: {}` works on 0.8 and 0.9; 0.9 additionally returns an owned
 * observation that has to be released when the plugin unloads (0.8 has none).
 */
interface WorkspaceObservation {
  release?: () => Promise<void>;
}

interface LoadedConfig {
  buttons: ButtonConfig[];
  source: string;
  exists: boolean;
  error: string | null;
}

export default function contribute(client: PluginClientContext) {
  configureRuns({
    start: (input) => client.rpc(runScriptStartRpc, input),
    poll: (input) => client.rpc(runScriptPollRpc, input),
    stop: (input) => client.rpc(runScriptStopRpc, input),
    openApp: (input) => client.rpc(openAppRpc, input),
  });
  configureUsage({
    fetch: (input) => client.rpc(usageFetchRpc, input),
    saveConfig: (input) => client.rpc(usageConfigSaveRpc, input),
    setDefault: (input) => client.rpc(usageSetDefaultRpc, input),
  });
  configureLastUsed({
    load: async () => {
      // Same startup race as load-config: the daemon-side session may not be
      // ready yet, so retry before giving up on the persisted choice.
      const result = await withRetry(() => client.rpc(lastUsedGetRpc, {}));
      return result?.tools ?? {};
    },
    save: (workspaceId, key) =>
      client.rpc(lastUsedSetRpc, {
        workspaceId,
        kind: key.kind,
        id: key.id,
        index: key.index,
      }),
  });

  // Display locations come from plugin.config.json. Paseo registers workspace
  // panel locations once at plugin load, so this is plugin-level (not per
  // project): edit plugin.config.json, then `paseo plugin reload`.
  const { locations, error: locationsError } = resolvePanelLocations(
    (pluginConfig as { locations?: unknown }).locations,
  );
  if (locationsError) {
    console.warn(`${LOG_PREFIX} plugin.config.json: ${locationsError}`);
  }
  console.log(`${LOG_PREFIX} panel locations: ${locations.join(", ")}`);

  client.addWorkspacePanel({
    id: COMMANDS_PANEL_ID,
    title: "Commands",
    icon: "SquareTerminal",
    context: "workspace",
    locations,
    Component: CommandsPanel,
  });

  client.addCommandCenterItem({
    id: "open-commands",
    title: "Open project commands",
    icon: "SquareTerminal",
    keywords: ["paseo.json", "godot", "script", "usage", "topbar"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel(COMMANDS_PANEL_ID);
    },
  });

  // --- header buttons --------------------------------------------------------
  // Two per workspace, emulating a split button: RUN_BUTTON_ID on the left
  // repeats the last tool, HEADER_BUTTON_ID on the right opens the dropdown.
  interface HeaderRegistrations {
    run: PluginButtonRegistration;
    menu: PluginButtonRegistration;
  }
  const registrations = new Map<string, HeaderRegistrations>();
  const projectRoots = new Map<string, string>();
  const configs = new Map<string, LoadedConfig>();
  const refreshes = new Map<string, Promise<void>>();
  const menuUpdates = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let workspaceObservation: WorkspaceObservation | null = null;

  /**
   * The client entry can be evaluated before the daemon-side plugin session is
   * ready to answer RPCs, so bootstrap reads retry with a short backoff.
   */
  async function withRetry<T>(run: () => Promise<T>): Promise<T | null> {
    for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        if (disposed || attempt === BOOTSTRAP_ATTEMPTS) {
          console.error(`${LOG_PREFIX} RPC failed`, error);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
    return null;
  }

  function hideButton(workspaceId: string) {
    const existing = registrations.get(workspaceId);
    if (!existing) return;
    existing.run.remove();
    existing.menu.remove();
    registrations.delete(workspaceId);
  }

  function forget(workspaceId: string) {
    hideButton(workspaceId);
    projectRoots.delete(workspaceId);
    configs.delete(workspaceId);
    refreshes.delete(workspaceId);
    clearWorkspaceRefresher(workspaceId);
  }

  /**
   * Rebuild this workspace's header buttons from the cached config plus current
   * usage/last-used state. No RPC here: this also runs when a usage fetch
   * settles, and a menu title update must not re-read paseo.json.
   */
  function updateButtons(workspaceId: string) {
    const projectRoot = projectRoots.get(workspaceId);
    const config = configs.get(workspaceId);
    if (disposed || !projectRoot || !config) return;

    const menuButton = createHeaderMenu({
      client,
      workspaceId,
      projectRoot,
      config,
      onReload: () => requestRefresh(workspaceId),
    });
    const runButton = createRunButton(
      workspaceId,
      projectRoot,
      lastUsedStore.resolve(workspaceId, config.buttons),
    );

    const existing = registrations.get(workspaceId);
    if (existing) {
      existing.run.update(runButton);
      existing.menu.update(menuButton);
      return;
    }

    // Registration order is render order: left (run) first, right (menu) second.
    const run = client.addHeaderButton({ id: RUN_BUTTON_ID, workspaceId, button: runButton });
    const menu = client.addHeaderButton({ id: HEADER_BUTTON_ID, workspaceId, button: menuButton });
    if (disposed) {
      run.remove();
      menu.remove();
      return;
    }
    registrations.set(workspaceId, { run, menu });
  }

  /** Coalesce usage-driven menu updates; a fetch settling many entries is one update. */
  function scheduleMenuUpdate(workspaceId: string) {
    if (disposed || menuUpdates.has(workspaceId)) return;
    menuUpdates.set(
      workspaceId,
      setTimeout(() => {
        menuUpdates.delete(workspaceId);
        updateButtons(workspaceId);
      }, 250),
    );
  }

  async function refresh(workspaceId: string) {
    const projectRoot = projectRoots.get(workspaceId);
    if (disposed || !projectRoot) return;

    const config = await withRetry(() => client.rpc(loadConfigRpc, { projectRoot }));
    // Drop stale results: the workspace may have been removed or re-rooted.
    if (!config || disposed || projectRoots.get(workspaceId) !== projectRoot) return;

    // No paseo.json in this project: no header button. Use the panel's
    // "重新加载" after creating the file to bring the button in.
    if (!config.exists) {
      configs.delete(workspaceId);
      usageStore.track(workspaceId, projectRoot, []);
      hideButton(workspaceId);
      return;
    }

    configs.set(workspaceId, config);
    // Pass the full list: usage card keys are positions in it (see usageStore.track).
    usageStore.track(workspaceId, projectRoot, config.buttons);
    updateButtons(workspaceId);
  }

  /** Serialized per workspace so two updates cannot register the same button twice. */
  function requestRefresh(workspaceId: string) {
    const previous = refreshes.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(() => refresh(workspaceId)).catch((error: unknown) => {
      console.error(`${LOG_PREFIX} header button refresh failed`, error);
    });
    refreshes.set(workspaceId, next);
  }

  function track(workspaceId: string, projectRoot: string) {
    if (disposed || projectRoots.get(workspaceId) === projectRoot) return;
    projectRoots.set(workspaceId, projectRoot);
    // Registered once per workspace and kept while the button is hidden, so the
    // panel's reload can also re-create a button.
    setWorkspaceRefresher(workspaceId, () => requestRefresh(workspaceId));
    requestRefresh(workspaceId);
  }

  const unsubscribe = client.paseo.workspaces.subscribe((update) => {
    if (disposed) return;
    if (update.kind === "upsert") track(update.workspace.id, update.workspace.projectRootPath);
    else forget(update.id);
  });

  // Menu titles carry usage summaries, so rebuild them when usage changes.
  const unsubscribeUsage = usageStore.subscribe(() => {
    for (const workspaceId of projectRoots.keys()) scheduleMenuUpdate(workspaceId);
  });

  // The left button follows the last-used tool, so a click rebuilds both buttons.
  const unsubscribeLastUsed = lastUsedStore.subscribe(() => {
    for (const workspaceId of projectRoots.keys()) scheduleMenuUpdate(workspaceId);
  });

  let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  let bootstrapped = false;

  /** Release the 0.9 owned workspace observation (a no-op on 0.8). */
  async function releaseWorkspaceObservation() {
    const observation = workspaceObservation;
    workspaceObservation = null;
    if (!observation?.release) return;
    try {
      await observation.release();
    } catch (error) {
      console.error(`${LOG_PREFIX} workspace observation release failed`, error);
    }
  }

  /**
   * The host client can be connected but still too early for plugin RPCs (the
   * daemon-side subprocess may not be ready). Retry the initial workspace list a
   * few times, then give up quietly: a later workspace update still registers its
   * button, and the panel's reload covers the rest.
   */
  async function bootstrap(attempt = 0) {
    if (disposed || bootstrapped) return;
    const page = await withRetry(() => client.paseo.workspaces.list({ subscribe: {} }));
    if (disposed) {
      void (page as unknown as { subscription?: WorkspaceObservation } | null)?.subscription
        ?.release?.()
        .catch(() => {});
      return;
    }
    if (!page) {
      if (attempt < 3) {
        bootstrapTimer = setTimeout(() => void bootstrap(attempt + 1), BOOTSTRAP_RETRY_MS);
      }
      return;
    }
    bootstrapped = true;
    // 0.9 returns the owned observation that feeds `workspaces.subscribe`
    // listeners; keep it so cleanup can release it. 0.8 returns nothing here and
    // keeps the daemon-side stream alive until the connection closes.
    workspaceObservation =
      (page as unknown as { subscription?: WorkspaceObservation }).subscription ?? null;
    for (const workspace of page.entries) track(workspace.id, workspace.projectRootPath);
  }

  void bootstrap();
  // Persisted "last used" replaces the first-runnable default once loaded.
  void lastUsedStore.hydrate();

  return () => {
    disposed = true;
    if (bootstrapTimer) clearTimeout(bootstrapTimer);
    void releaseWorkspaceObservation();
    for (const timer of menuUpdates.values()) clearTimeout(timer);
    menuUpdates.clear();
    unsubscribe();
    unsubscribeUsage();
    unsubscribeLastUsed();
    for (const workspaceId of [...projectRoots.keys()]) {
      const existing = registrations.get(workspaceId);
      existing?.run.remove();
      existing?.menu.remove();
      clearWorkspaceRefresher(workspaceId);
    }
    registrations.clear();
    projectRoots.clear();
    configs.clear();
    refreshes.clear();
    configureRuns(null);
    configureUsage(null);
    configureLastUsed(null);
  };
}
