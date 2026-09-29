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
import { handleUsageConfigSave, handleUsageFetch, handleUsageSetDefault } from "./server/usage";
import { handleLastUsedGet, handleLastUsedSet } from "./server/state";
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

export default function contribute(server: PluginServerContext) {
  server.handle(loadConfigRpc, handleLoadConfig);
  server.handle(openAppRpc, handleOpenApp);
  server.handle(runScriptStartRpc, handleRunScriptStart);
  server.handle(runScriptPollRpc, handleRunScriptPoll);
  server.handle(runScriptStopRpc, handleRunScriptStop);
  server.handle(usageFetchRpc, handleUsageFetch);
  server.handle(usageConfigSaveRpc, handleUsageConfigSave);
  server.handle(usageSetDefaultRpc, handleUsageSetDefault);
  server.handle(lastUsedGetRpc, handleLastUsedGet);
  server.handle(lastUsedSetRpc, handleLastUsedSet);

  return () => {
    console.log("[paseo-topbar-command] plugin cleanup: unloading, stopping scripts");
    stopAllScripts();
  };
}
