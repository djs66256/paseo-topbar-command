// Server entry (Paseo 0.8 runtime entry). Registers the daemon-side RPC
// handlers and stops any running script jobs when the plugin unloads.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  handleLoadConfig,
  handleOpenApp,
  handleRunScriptPoll,
  handleRunScriptStart,
  handleRunScriptStop,
  stopAllScripts,
} from "./server/commands";
import {
  loadConfigRpc,
  openAppRpc,
  runScriptPollRpc,
  runScriptStartRpc,
  runScriptStopRpc,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(loadConfigRpc, handleLoadConfig);
  server.handle(openAppRpc, handleOpenApp);
  server.handle(runScriptStartRpc, handleRunScriptStart);
  server.handle(runScriptPollRpc, handleRunScriptPoll);
  server.handle(runScriptStopRpc, handleRunScriptStop);

  return () => {
    stopAllScripts();
  };
}
