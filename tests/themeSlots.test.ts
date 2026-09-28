import { afterEach, describe, expect, it } from 'vitest';
import type { Unregister } from '../src/extensions.js';
import { FOSTER_DAY, FOSTER_NIGHT, registerThemeSlot, themeColor } from '../src/tui/theme.js';
import { meter, stripAnsi, visibleWidth } from '../src/tui/widgets.js';

let undo: Unregister[] = [];

afterEach(() => {
  for (const step of undo.reverse()) step();
  undo = [];
});

describe('theme slots', () => {
  it('resolves a registered slot per theme, and forgets it once unregistered', () => {
    expect(themeColor(FOSTER_NIGHT, 'gauge')).toBeUndefined();
    const off = registerThemeSlot({ name: 'gauge', night: '#112233', day: '#445566' });
    expect(themeColor(FOSTER_NIGHT, 'gauge')).toBe('#112233');
    expect(themeColor(FOSTER_DAY, 'gauge')).toBe('#445566');
    off();
    expect(themeColor(FOSTER_NIGHT, 'gauge')).toBeUndefined();
  });

  it('returns undefined for an unknown slot and never lets a slot repaint a core one', () => {
    expect(themeColor(FOSTER_NIGHT, 'nope')).toBeUndefined();
    undo.push(registerThemeSlot({ name: 'accent', night: '#000000', day: '#000000' }));
    expect(themeColor(FOSTER_NIGHT, 'accent')).toBe(FOSTER_NIGHT.accent);
    expect(themeColor(FOSTER_NIGHT, 'label')).toBeUndefined();
  });

  it('refuses a colour that is not #rrggbb', () => {
    expect(() => registerThemeSlot({ name: 'bad', night: 'red', day: '#000000' })).toThrow(
      /#rrggbb/,
    );
  });
});

describe('meter', () => {
  it.each(['truecolor', '256', '16', 'none'] as const)(
    'is exactly as wide as asked (%s)',
    (level) => {
      for (const fraction of [0, 0.5, 1, -1, 2, Number.NaN]) {
        expect(visibleWidth(meter(level, FOSTER_NIGHT, fraction, 10))).toBe(10);
      }
    },
  );

  it('fills in proportion', () => {
    expect(stripAnsi(meter('none', FOSTER_NIGHT, 0, 4))).toBe('░░░░');
    expect(stripAnsi(meter('none', FOSTER_NIGHT, 0.5, 4))).toBe('██░░');
    expect(stripAnsi(meter('none', FOSTER_NIGHT, 1, 4))).toBe('████');
  });

  it('paints the filled part with the slot, falling back to the accent', () => {
    undo.push(registerThemeSlot({ name: 'gauge', night: '#ff0000', day: '#00ff00' }));
    expect(meter('truecolor', FOSTER_NIGHT, 1, 2, 'gauge')).toContain('38;2;255;0;0');
    expect(meter('truecolor', FOSTER_NIGHT, 1, 2, 'missing')).toContain('38;2;61;214;198');
  });
});
