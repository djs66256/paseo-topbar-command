// Client entry (Paseo 0.8 runtime entry). Registers the per-project command
// panel and the Command Center item that opens it.
//
// NOTE ON "TOPBAR": Paseo 0.8 does expose header buttons via
// `client.addHeaderButton({ id, workspaceId, button })`, but a header button is
// bound to one workspace at registration time, so a workspace panel (a tab in
// the workspace header row, next to Agents / Terminal / Files) is still the
// contribution that fits a per-project paseo.json config.
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CommandsPanel } from "./client/commands";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "commands",
    title: "Commands",
    icon: "SquareTerminal",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: CommandsPanel,
  });

  client.addCommandCenterItem({
    id: "open-commands",
    title: "Open project commands",
    icon: "SquareTerminal",
    keywords: ["paseo.json", "godot", "script", "topbar"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("commands");
    },
  });

  return () => {};
}
