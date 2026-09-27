import type { ForeignLedgerEvent, Ledger, LedgerRecord } from './log.js';
import { CORE_EVENT_KINDS, isCoreEvent } from './log.js';

/**
 * State a plugin keeps in the shared ledger, folded from the event kinds it
 * owns.
 *
 * The core's own fold (`project()`) never sees these events: `Ledger.read()`
 * hands it core kinds only. A reducer gets the rest, filtered to the kinds it
 * named, in file order, and its state lives in a slot of its own, keyed by the
 * reducer's `slot`, so two plugins can never fold into each other's state.
 *
 * Kinds are strings the plugin chooses. A namespace prefix (`fleet.`,
 * `example.`) keeps them from colliding with a core kind added later, and a
 * reducer may also list un-namespaced names it wrote before it had one.
 */
export interface LedgerReducer<S> {
  /** The state slot this reducer owns; one reducer per slot. */
  slot: string;
  /** The event kinds this reducer folds. Core kinds are refused. */
  kinds: readonly string[];
  initial(): S;
  reduce(state: S, event: ForeignLedgerEvent): S;
}

const reducers = new Map<string, LedgerReducer<unknown>>();

/** Registers a reducer for its slot. Returns a function that removes it again. */
export function registerLedgerReducer<S>(reducer: LedgerReducer<S>): () => void {
  const core = reducer.kinds.filter((kind) => CORE_EVENT_KINDS.has(kind));
  if (core.length > 0) {
    throw new Error(`ledger reducer "${reducer.slot}" claims core kind(s): ${core.join(', ')}`);
  }
  if (reducers.has(reducer.slot)) {
    throw new Error(`a ledger reducer is already registered for slot "${reducer.slot}"`);
  }
  reducers.set(reducer.slot, reducer as LedgerReducer<unknown>);
  return () => {
    if (reducers.get(reducer.slot) === reducer) reducers.delete(reducer.slot);
  };
}

/** Folds one slot's state out of a ledger (or an array of records). */
export function projectSlot<S>(source: Ledger | readonly LedgerRecord[], slot: string): S {
  const reducer = reducers.get(slot) as LedgerReducer<S> | undefined;
  if (!reducer) throw new Error(`no ledger reducer is registered for slot "${slot}"`);
  const records = Array.isArray(source) ? source : (source as Ledger).readRecords();
  const kinds = new Set(reducer.kinds);
  let state = reducer.initial();
  for (const record of records as readonly LedgerRecord[]) {
    if (isCoreEvent(record) || !kinds.has(record.kind)) continue;
    state = reducer.reduce(state, record as ForeignLedgerEvent);
  }
  return state;
}

/** The slots that currently have a reducer, for diagnostics. */
export function ledgerSlots(): string[] {
  return [...reducers.keys()];
}
