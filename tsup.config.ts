import { defineConfig, type Options } from 'tsup';

const bin: Options = {
  entry: { homecoming: 'src/bin.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  // Not `clean`: the two builds run in parallel and a clean here could wipe the
  // library's output mid-build. `npm run build` empties dist/ first instead.
  platform: 'node',
  // Single self-contained file so install.ps1 can fetch and SHA256-verify one artifact.
  noExternal: [/.*/],
  banner: {
    // Bundled CommonJS dependencies still call require() for Node builtins, which
    // does not exist in an ESM output — createRequire gives them a working one.
    //
    // No `module.enableCompileCache()` here: measured (built bundle, `homecoming
    // --version` timed over multiple 20-run trials, with a warmed persistent
    // NODE_COMPILE_CACHE dir to mirror real repeated-launch conditions) to make
    // no difference to ordinary invocations. `enableCompileCache()` only caches
    // compilation of modules loaded *after* the call — it cannot cache the very
    // script it runs inside, which V8 has already fully parsed and compiled by
    // the time any of that script's own top-level statements execute. Since
    // this bundle is a single self-contained file (see `noExternal` above),
    // there is nothing loaded later for it to help with.
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __nodeCreateRequire } from 'node:module';",
      'const require = __nodeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
};

/**
 * The library a plugin imports: `runCli`, `definePlugin` and the extension
 * points, with type declarations. Kept in `dist/lib/` so the installer's single
 * artifact above stays the only file at the top of `dist/`.
 */
const lib: Options = {
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist/lib',
  platform: 'node',
  dts: true,
  sourcemap: false,
};

export default defineConfig([bin, lib]);
