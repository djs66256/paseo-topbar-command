// Plugin entry. Registers the per-project command panel, a Command Center
// item to open it, and the daemon-side RPC handlers.
//
// NOTE ON "TOPBAR": Paseo 0.7's plugin API has no topbar/header-button
// contribution point (it is on the Paseo plugin roadmap; v0.8 adds header
// buttons). The supported equivalent is a workspace panel: it appears as a
// tab in the workspace header row, next to Agents / Terminal / Files, and is
// per-project — a natural fit for the per-project paseo.json config.
import type { PluginContext } from "@getpaseo/plugin";
import { CommandsPanel } from "./commands.client";
import {
  handleLoadConfig,
  handleOpenApp,
  handleRunScriptPoll,
  handleRunScriptStart,
  handleRunScriptStop,
  stopAllScripts,
} from "./commands.server";
import {
  loadConfigRpc,
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
} from "./rpc.shared";

export default function contribute(plugin: PluginContext) {
  plugin.addWorkspacePanel({
    id: "commands",
    title: "Commands",
    icon: "SquareTerminal",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: CommandsPanel,
  });

  plugin.addCommandCenterItem({
    id: "open-commands",
    title: "Open project commands",
    icon: "SquareTerminal",
    keywords: ["paseo.json", "godot", "script", "topbar"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("commands");
    },
  });

  plugin.handle(loadConfigRpc, handleLoadConfig);
  plugin.handle(openAppRpc, handleOpenApp);
  plugin.handle(runScriptStartRpc, handleRunScriptStart);
  plugin.handle(runScriptPollRpc, handleRunScriptPoll);
  plugin.handle(runScriptStopRpc, handleRunScriptStop);

  return () => {
    // `stopAllScripts` lives in commands.server.ts, which the client build strips
    // out of index.ts. The typeof guard keeps the client cleanup a safe no-op while
    // the daemon bundle actually terminates any running script jobs.
    if (typeof stopAllScripts === "function") {
      console.log("[paseo-topbar-command] plugin cleanup: unloading, stopping scripts");
      stopAllScripts();
    }
  };
}
