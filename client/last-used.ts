// "Last clicked tool" per workspace, for the header split button.
//
// Paseo has no split-button primitive ("the whole trigger opens the surface"),
// so the client entry registers two header buttons instead: the left one repeats
// the last tool the user clicked, the right one opens the dropdown. This store
// remembers that choice and resolves it against the current paseo.json.
//
// Class-free on purpose: see the Hermes note in client/run-store.ts.
import type { AppButton, ButtonConfig, ScriptButton } from "../shared/config";

const LOG_PREFIX = "[paseo-topbar-command]";

export type ToolKind = "app" | "script";
export type RunnableButton = AppButton | ScriptButton;

export interface ToolKey {
  readonly kind: ToolKind;
  readonly id: string;
  /** Position in paseo.json at click time; used as a fallback after edits. */
  readonly index: number;
}

export interface RunnableTool {
  readonly key: ToolKey;
  readonly button: RunnableButton;
}

/** Bound RPC calls; the entry wires them to `client.rpc`. */
export interface LastUsedTransport {
  load(): Promise<Record<string, ToolKey>>;
  save(workspaceId: string, key: ToolKey): Promise<unknown>;
}

export interface LastUsedStore {
  subscribe(listener: () => void): () => void;
  configure(transport: LastUsedTransport | null): void;
  /** Read daemon state once; local clicks always win over the persisted copy. */
  hydrate(): Promise<void>;
  /** Resolve the remembered tool against the current config, else the first runnable one. */
  resolve(workspaceId: string, buttons: readonly ButtonConfig[]): RunnableTool | null;
  /** Remember a click. Publishes immediately and persists in the background. */
  record(workspaceId: string, key: ToolKey): void;
}

function isRunnable(button: ButtonConfig): button is RunnableButton {
  return button.type === "app" || button.type === "script";
}

function isToolKey(value: unknown): value is ToolKey {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === "app" || record.kind === "script") &&
    typeof record.id === "string" &&
    record.id.trim() !== "" &&
    typeof record.index === "number" &&
    Number.isInteger(record.index) &&
    record.index >= 0
  );
}

function runnableKey(button: RunnableButton, index: number): ToolKey {
  return { kind: button.type, id: button.id, index };
}

function createLastUsedStore(): LastUsedStore {
  let transport: LastUsedTransport | null = null;
  const listeners = new Set<() => void>();
  const tools = new Map<string, ToolKey>();
  let hydrating: Promise<void> | null = null;
  let hydrated = false;

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function publish(): void {
    for (const listener of listeners) listener();
  }

  function configure(next: LastUsedTransport | null): void {
    transport = next;
    tools.clear();
    hydrating = null;
    hydrated = false;
  }

  async function hydrate(): Promise<void> {
    const active = transport;
    if (!active || hydrated) return;
    if (hydrating) return hydrating;
    hydrating = (async () => {
      try {
        const remote = await active.load();
        let changed = false;
        for (const [workspaceId, key] of Object.entries(remote)) {
          // A click that landed while the read was in flight wins the race.
          if (tools.has(workspaceId) || !isToolKey(key)) continue;
          tools.set(workspaceId, key);
          changed = true;
        }
        if (changed) publish();
      } catch (error) {
        console.error(`${LOG_PREFIX} last-used: load failed`, error);
      } finally {
        hydrated = true;
        hydrating = null;
      }
    })();
    return hydrating;
  }

  function record(workspaceId: string, key: ToolKey): void {
    const previous = tools.get(workspaceId);
    if (
      previous &&
      previous.kind === key.kind &&
      previous.id === key.id &&
      previous.index === key.index
    ) {
      return;
    }
    tools.set(workspaceId, key);
    publish();
    const active = transport;
    if (!active) return;
    active.save(workspaceId, key).catch((error: unknown) => {
      console.error(`${LOG_PREFIX} last-used: save failed`, error);
    });
  }

  function resolve(workspaceId: string, buttons: readonly ButtonConfig[]): RunnableTool | null {
    const stored = tools.get(workspaceId);
    if (stored) {
      // Identity first, so reordering paseo.json keeps the choice.
      const byIdentity = buttons.findIndex(
        (button) => isRunnable(button) && button.type === stored.kind && button.id === stored.id,
      );
      if (byIdentity >= 0) {
        const button = buttons[byIdentity] as RunnableButton;
        return { key: runnableKey(button, byIdentity), button };
      }
      // Position fallback: the id changed but the slot is still the same kind.
      const atIndex = buttons[stored.index];
      if (atIndex && isRunnable(atIndex) && atIndex.type === stored.kind) {
        return { key: runnableKey(atIndex, stored.index), button: atIndex };
      }
    }
    // No memory yet (or it no longer exists): the first runnable button, so the
    // left slot is useful before the first dropdown click.
    const first = buttons.findIndex(isRunnable);
    if (first < 0) return null;
    const button = buttons[first] as RunnableButton;
    return { key: runnableKey(button, first), button };
  }

  return { subscribe, configure, hydrate, resolve, record };
}

export const lastUsedStore = createLastUsedStore();

/** Called by the client entry on load, and with `null` on cleanup. */
export function configureLastUsed(transport: LastUsedTransport | null): void {
  lastUsedStore.configure(transport);
}
