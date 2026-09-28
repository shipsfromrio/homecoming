import type { Unregister } from '../extensions.js';

/**
 * Named colour slots: one palette, quantized to whatever
 * the terminal can actually paint.
 *
 * Callers never pick an ANSI name. A border and a title go through
 * the same slots so a theme switch (or NO_COLOR) cannot leave one widget on
 * the old cyan while the rest of the screen has moved.
 */

export type ColorLevel = 'truecolor' | '256' | '16' | 'none';

export type ThemeName = 'night' | 'day';

export interface Theme {
  name: ThemeName;
  label: string;
  hint: string;
  bg: string;
  bgPanel: string;
  bgHighlight: string;
  fg: string;
  fgDim: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  border: string;
}

/** Neutral dark, cyan accent — the colour the old clack badge already wore. */
export const FOSTER_NIGHT: Theme = {
  name: 'night',
  label: 'Night',
  hint: 'dark, cyan accent',
  bg: '#0e1116',
  bgPanel: '#161b22',
  bgHighlight: '#1f2a33',
  fg: '#e6edf3',
  fgDim: '#8b9bab',
  accent: '#3dd6c6',
  success: '#3dd68c',
  warning: '#e3b341',
  error: '#f85149',
  border: '#30363d',
};

export const FOSTER_DAY: Theme = {
  name: 'day',
  label: 'Day',
  hint: 'light terminal',
  bg: '#f6f8fa',
  bgPanel: '#ffffff',
  bgHighlight: '#ddf4ff',
  fg: '#1f2328',
  fgDim: '#656d76',
  accent: '#117a72',
  success: '#1a7f37',
  warning: '#9a6700',
  error: '#cf222e',
  border: '#d0d7de',
};

export const THEMES: Record<ThemeName, Theme> = {
  night: FOSTER_NIGHT,
  day: FOSTER_DAY,
};

export function themeNamed(name: string | undefined): Theme {
  return name === 'day' ? FOSTER_DAY : FOSTER_NIGHT;
}

/**
 * What this process can paint. Windows Terminal and the VS Code family advertise
 * truecolor; a piped test or NO_COLOR must not emit any CSI.
 */
export function detectColorLevel(env: NodeJS.ProcessEnv = process.env): ColorLevel {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.FORCE_COLOR === '0') return 'none';
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  if (env.WT_SESSION || env.TERM_PROGRAM === 'vscode') return 'truecolor';
  const term = env.TERM ?? '';
  if (term.includes('256') || term === 'xterm-ghostty') return '256';
  if (term === 'dumb') return 'none';
  // Modern Windows consoles speak VT; assuming 16-color here made the default
  // theme look like a 1990s install in the one place foster actually runs.
  return process.platform === 'win32' ? 'truecolor' : '256';
}

export function hexRgb(hex: string): [number, number, number] {
  const body = hex.replace('#', '');
  return [
    Number.parseInt(body.slice(0, 2), 16),
    Number.parseInt(body.slice(2, 4), 16),
    Number.parseInt(body.slice(4, 6), 16),
  ];
}

export function fgCode(hex: string, level: ColorLevel): string {
  if (level === 'none') return '';
  const [r, g, b] = hexRgb(hex);
  if (level === 'truecolor') return `\x1b[38;2;${r};${g};${b}m`;
  if (level === '256') return `\x1b[38;5;${to256(r, g, b)}m`;
  return `\x1b[${ansiFg(r, g, b)}m`;
}

export function bgCode(hex: string, level: ColorLevel): string {
  if (level === 'none') return '';
  const [r, g, b] = hexRgb(hex);
  if (level === 'truecolor') return `\x1b[48;2;${r};${g};${b}m`;
  if (level === '256') return `\x1b[48;5;${to256(r, g, b)}m`;
  return `\x1b[${ansiBg(r, g, b)}m`;
}

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
/**
 * Reverse video. The badge uses this instead of an explicit background pair:
 * the terminal swaps the cell's own colours, which survives environments where
 * an explicit `48;2` background is dropped (observed under ConPTY with the
 * acrylic renderer) and degrades to plain text when colour is off entirely.
 */
export const REVERSE = '\x1b[7m';

export function to256(r: number, g: number, b: number): number {
  const grayish = Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && Math.abs(r - b) < 10;
  if (grayish) {
    const y = Math.round((r + g + b) / 3);
    if (y < 8) return 16;
    if (y > 238) return 231;
    return 232 + Math.round(((y - 8) / 247) * 23);
  }
  const step = (n: number) => Math.round((n / 255) * 5);
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

function ansiFg(r: number, g: number, b: number): number {
  return 30 + ansiIndex(r, g, b);
}

function ansiBg(r: number, g: number, b: number): number {
  return 40 + ansiIndex(r, g, b);
}

function ansiIndex(r: number, g: number, b: number): number {
  const bits = (n: number) => (n > 96 ? 1 : 0);
  return bits(r) + bits(g) * 2 + bits(b) * 4;
}

// ---------------------------------------------------------------------------
// Extra colour slots

/**
 * A named colour a plugin adds to both themes, for widgets of its own. Colours
 * are `#rrggbb`, like the core slots, so they quantize the same way.
 */
export interface ThemeSlot {
  name: string;
  night: string;
  day: string;
}

const HEX = /^#[0-9a-f]{6}$/i;
const themeSlots: ThemeSlot[] = [];

/** The core slots, which a registered slot cannot redefine. */
const CORE_SLOTS: ReadonlySet<string> = new Set(
  Object.keys(FOSTER_NIGHT).filter((key) => HEX.test(String(FOSTER_NIGHT[key as keyof Theme]))),
);

/**
 * Adds a colour slot. A name the core already uses, or one an earlier slot
 * took, is ignored rather than allowed to repaint it; a colour that is not
 * `#rrggbb` is refused.
 */
export function registerThemeSlot(slot: ThemeSlot): Unregister {
  if (!HEX.test(slot.night) || !HEX.test(slot.day)) {
    throw new Error(`theme slot "${slot.name}" needs #rrggbb colours`);
  }
  themeSlots.push(slot);
  return () => {
    const at = themeSlots.indexOf(slot);
    if (at >= 0) themeSlots.splice(at, 1);
  };
}

/**
 * The colour a slot has in a theme: a core slot by its name, then the first
 * registered slot of that name. Undefined for a name nobody defined.
 */
export function themeColor(theme: Theme, slot: string): string | undefined {
  if (CORE_SLOTS.has(slot)) return theme[slot as keyof Theme];
  const found = themeSlots.find((entry) => entry.name === slot);
  if (!found) return undefined;
  return theme.name === 'day' ? found.day : found.night;
}
