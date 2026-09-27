import { listMenuItems } from '../extensions.js';
import type { Choice } from './ui.js';

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
export function accountActions(account: {
  isCurrent: boolean;
  label?: string;
  identityName?: string;
  shortId: string;
  sessions: number;
}): Choice[] {
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
  const alias = COMMAND_ALIASES[raw.toLowerCase()];
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
