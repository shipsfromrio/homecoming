import { afterEach, describe, expect, it } from 'vitest';
import { programName, setProgramName } from '../src/programName.js';
import { restartCommandFromArgv } from '../src/engine/detach.js';

/**
 * The binary name the core writes into every command line it suggests. The
 * default build never sets it; a bundle under another binary name sets its own.
 */
afterEach(() => {
  setProgramName('homecoming');
});

describe('program name', () => {
  it('is homecoming unless a build sets its own', () => {
    expect(programName()).toBe('homecoming');
  });

  it('reaches a command line built at run time', () => {
    setProgramName('otherbin');
    expect(programName()).toBe('otherbin');
    expect(restartCommandFromArgv(['layout'])).toBe('otherbin layout --yes --restart');
  });

  it('refuses what is not a plain command word, keeping the name it had', () => {
    for (const bad of ['', 'Otherbin', 'other bin', 'rm -rf', '../x', 'a;b']) {
      expect(() => setProgramName(bad), bad).toThrow(/plain command word/);
    }
    expect(programName()).toBe('homecoming');
  });
});
