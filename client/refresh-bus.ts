// Lets the Commands panel ask the client entry to re-read paseo.json and update
// that workspace's header button. The entry registers one refresher per tracked
// workspace; it stays registered while the button is hidden so the panel's
// "重新加载" can bring a newly created paseo.json into the header.
const refreshers = new Map<string, () => void>();

export function setWorkspaceRefresher(workspaceId: string, refresh: () => void): void {
  refreshers.set(workspaceId, refresh);
}

export function clearWorkspaceRefresher(workspaceId: string): void {
  refreshers.delete(workspaceId);
}

/** No-op for workspaces the plugin does not track. */
export function refreshWorkspaceMenu(workspaceId: string): void {
  refreshers.get(workspaceId)?.();
}
