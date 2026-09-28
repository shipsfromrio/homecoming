import { listAccountMenuItems, listMenuItems, type AccountMenuItem } from '../extensions.js';
import type { Choice, DashboardAccount } from './ui.js';

/**
 * The command menu. Values match the old clack menu so the flows and the
 * scripted tests keep the same vocabulary.
 */
export interface Command extends Choice {
  slash: string;
  /** Empty-prompt hotkey on the home screen. */
  hotkey?: string;
}

export const COMMANDS: Command[] = [
  {
    value: 'foster',
    slash: 'foster',
    hotkey: 'f',
    label: 'Bring sessions here',
    hint: "copy another account's sessions into this one",
  },
  {
    value: 'sweep',
    slash: 'sweep',
    hotkey: 'e',
    label: 'Bring everything here',
    hint: 'archived and deleted included, then check nothing is left',
  },
  {
    value: 'return',
    slash: 'return',
    hotkey: 'r',
    label: 'Send them back',
    hint: 'remove the copies, restoring the previous state',
  },
  {
    value: 'restore',
    slash: 'restore',
    label: 'Undo a deletion',
    hint: 'bring back a session deleted in the app',
  },
  {
    value: 'status',
    slash: 'status',
    hotkey: 's',
    label: 'What homecoming has done',
    hint: 'copies currently in place',
  },
  {
    value: 'browse',
    slash: 'browse',
    hotkey: 'b',
    label: 'What is on disk',
    hint: 'accounts, organizations and session counts',
  },
  {
    value: 'label',
    slash: 'label',
    hotkey: 'l',
    label: 'Name an account',
    hint: 'so you stop reading UUIDs',
  },
  {
    value: 'app',
    slash: 'app',
    label: 'Claude Desktop',
    hint: 'restart it — and why that is what makes changes show up',
  },
  {
    value: 'theme',
    slash: 'theme',
    label: 'Switch the colour theme',
    hint: 'Night or Day',
  },
  {
    value: 'home',
    slash: 'home',
    label: 'Back to the dashboard',
    hint: 'clear the current panel',
  },
  { value: 'quit', slash: 'quit', label: 'Quit', hint: 'leave foster' },
];

/**
 * The core menu plus every registered menu item, placed before the app, theme,
 * home and quit entries so the housekeeping stays at the bottom. An item whose
 * value or slash clashes with a core entry is left out rather than allowed to
 * shadow it, and a hotkey a core entry already uses is dropped.
 */
export function menuCommands(): Command[] {
  const extra = listMenuItems();
  if (extra.length === 0) return COMMANDS;
  const values = new Set(COMMANDS.flatMap((command) => [command.value, command.slash]));
  const hotkeys = new Set(COMMANDS.map((command) => command.hotkey).filter(Boolean));
  const added: Command[] = [];
  for (const item of extra) {
    if (values.has(item.value) || values.has(item.slash)) continue;
    values.add(item.value);
    values.add(item.slash);
    const hotkey = item.hotkey && !hotkeys.has(item.hotkey) ? item.hotkey : undefined;
    if (hotkey) hotkeys.add(hotkey);
    added.push({
      value: item.value,
      slash: item.slash,
      label: item.label,
      ...(item.hint !== undefined ? { hint: item.hint } : {}),
      ...(hotkey ? { hotkey } : {}),
    });
  }
  const at = COMMANDS.findIndex((command) => command.value === 'app');
  return [...COMMANDS.slice(0, at), ...added, ...COMMANDS.slice(at)];
}

/**
 * What Enter offers for the account under the cursor. The signed-in account is
 * the destination, so "bring its sessions here" would be a no-op there; it gets
 * the read screens instead.
 */
export function accountActions(account: DashboardAccount): Choice[] {
  return [...coreAccountActions(account), ...extraAccountActions(account)];
}

/** The verbs the account menu answers to in the core; a registered item cannot take one. */
export const CORE_ACCOUNT_VERBS: readonly string[] = ['foster-from', 'details', 'label'];

/**
 * The registered account menu item answering to `value`, or undefined. An item
 * whose value is a core verb (account or menu) or a registered menu item's
 * value is never returned, and the first of two items with one value wins, so
 * what the menu offered and what the session runs cannot disagree.
 */
export function accountMenuItemFor(value: string): AccountMenuItem | undefined {
  const items = listAccountMenuItems();
  if (items.length === 0) return undefined;
  const taken = new Set<string>([
    ...CORE_ACCOUNT_VERBS,
    ...menuCommands().flatMap((command) => [command.value, command.slash]),
  ]);
  if (taken.has(value)) return undefined;
  return items.find((item) => item.value === value);
}

function extraAccountActions(account: DashboardAccount): Choice[] {
  const choices: Choice[] = [];
  const seen = new Set<string>();
  for (const item of listAccountMenuItems()) {
    if (seen.has(item.value) || accountMenuItemFor(item.value) !== item) continue;
    seen.add(item.value);
    let offered: boolean;
    let label: string;
    try {
      offered = item.when ? item.when(account) : true;
      label = typeof item.label === 'function' ? item.label(account) : item.label;
    } catch {
      // An item that cannot decide about this row is not offered on it; the
      // menu the core builds must still open.
      continue;
    }
    if (!offered) continue;
    choices.push({
      value: item.value,
      label,
      ...(item.hint !== undefined ? { hint: item.hint } : {}),
    });
  }
  return choices;
}

function coreAccountActions(account: DashboardAccount): Choice[] {
  const name = account.label ?? account.identityName ?? account.shortId;
  const label: Choice = {
    value: 'label',
    label: account.label ? `Rename "${name}"` : 'Name it',
    hint: 'so you stop reading UUIDs',
  };
  const details: Choice = {
    value: 'details',
    label: 'Who is this?',
    hint: 'who it is and what is on disk for it',
  };
  if (account.isCurrent) {
    return [details, label];
  }
  return [
    // Only offered when there is something to bring: a Cowork-only or empty
    // account would turn this entry into a promise that can only fail.
    ...(account.sessions > 0
      ? [
          {
            value: 'foster-from',
            label: 'Bring its sessions here',
            hint: `copy ${name}'s sessions into this account`,
          },
        ]
      : []),
    details,
    label,
  ];
}

export const COMMAND_ALIASES: Record<string, string> = {
  exit: 'quit',
  q: 'quit',
  t: 'theme',
  everything: 'sweep',
  all: 'sweep',
  welcome: 'home',
};

function aliasKey(word: string): string {
  return word.replace(/^\//, '').trim().toLowerCase();
}

/**
 * The core aliases plus every alias a registered menu item declares. An alias
 * already in the core table, or equal to any entry's value or slash, is
 * ignored, and so is one an earlier item claimed; an item that is not in the
 * menu (it clashed with a core entry) brings no aliases.
 */
export function menuAliases(commands: Command[] = menuCommands()): Record<string, string> {
  const items = listMenuItems();
  if (items.length === 0) return COMMAND_ALIASES;
  const aliases: Record<string, string> = { ...COMMAND_ALIASES };
  const taken = new Set(commands.flatMap((command) => [command.value, command.slash]));
  const core = new Set(COMMANDS.map((command) => command.value));
  // The entry the menu actually added for this item: same value and slash, and
  // not a core entry the item tried to shadow.
  const present = new Set(
    commands
      .filter((command) => !core.has(command.value))
      .map((command) => `${command.value}\u0000${command.slash}`),
  );
  for (const item of items) {
    if (!present.has(`${item.value}\u0000${item.slash}`)) continue;
    for (const word of item.aliases ?? []) {
      const key = aliasKey(word);
      if (!key || key in aliases || taken.has(key)) continue;
      aliases[key] = item.value;
    }
  }
  return aliases;
}

/** Case-insensitive subsequence / prefix score. 0 means no match. */
export function fuzzyScore(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/^\//, '');
  if (!q) return 1;
  if (t === q) return 200;
  if (t.startsWith(q)) return 120;
  if (t.includes(q)) return 80;

  let i = 0;
  let score = 20;
  let last = -2;
  for (let n = 0; n < t.length && i < q.length; n += 1) {
    if (t[n] !== q[i]) continue;
    score += n === last + 1 ? 4 : 1;
    last = n;
    i += 1;
  }
  return i === q.length ? score : 0;
}

export function filterCommands(query: string, commands: Command[] = menuCommands()): Command[] {
  const raw = query.replace(/^\//, '').trim();
  if (!raw) return commands;
  const table = menuAliases(commands);
  const key = raw.toLowerCase();
  const alias = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  const scored = commands
    .map((command) => {
      const score = Math.max(
        fuzzyScore(command.slash, raw),
        fuzzyScore(command.value, raw),
        fuzzyScore(command.label, raw),
        alias === command.value ? 150 : 0,
      );
      return { command, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.command.slash.localeCompare(b.command.slash));
  return scored.map((row) => row.command);
}

export function asChoices(commands: Command[] = menuCommands()): Choice[] {
  return commands.map(({ value, label, hint }) => ({ value, label, hint }));
}

/** Same score as the slash menu, so a typed overlay filter ranks like `/`. */
export function filterChoices(all: Choice[], query: string): Choice[] {
  const q = query.trim();
  if (!q) return all;
  return all
    .map((choice) => ({
      choice,
      score: Math.max(
        fuzzyScore(choice.label, q),
        fuzzyScore(choice.value, q),
        choice.hint ? fuzzyScore(choice.hint, q) : 0,
      ),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.choice.label.localeCompare(b.choice.label))
    .map((row) => row.choice);
}
