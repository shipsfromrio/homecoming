# Development and releasing

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

Tests run against **synthetic** store fixtures created in a temporary directory. They never read or
write a real Claude Desktop installation. `npm run check` (and CI's `privacy-guard` job, which runs
the same `scripts/privacy.mjs` rather than a second copy of its patterns) fails the build if
realistic account identifiers or personal filesystem paths appear anywhere `git add -A` would pick
up — tracked, staged, or merely untracked-but-not-`.gitignore`d. A plain `git grep` sees
only tracked files, so a fixture written but not yet `git add`-ed used to pass locally and only fail
once CI saw it tracked, after the push.

The guard also checks for names from a denylist that is deliberately **not** in this repository, in
any encoding: a guard that ships the names it guards publishes them. It reads the list from
`PRIVACY_DENYLIST` (CI passes a repository secret of that name), from the file named by
`PRIVACY_DENYLIST_FILE`, or from a `.privacy-denylist` file at the root, which `.gitignore` excludes.
With none of them the name check is skipped and the run says so; the release workflow sets
`PRIVACY_REQUIRE_DENYLIST=1`, so a release without the list fails. One entry per line: a plain word
(matched anywhere), `re:<pattern>`, or `author:<word>` (a whole word, allowed only in `LICENSE` and
`package.json`). A hit prints the file name, never the entry.

CI (`.github/workflows/ci.yml`) runs the checks above on Node 22 and 24, on Ubuntu and Windows — not
20, which vitest 5 (picked up to clear three high-severity dependency advisories) refuses to start
under at all; `package.json`'s own `"engines": ">=20"` is unaffected, since that floor describes the
built CLI, which carries no vitest dependency, not the dev toolchain. The `check` job runs `npm run
coverage`, not a plain `npm test`, since the coverage floor below is only ever collected and enforced
under `--coverage`; `npm run check` (`package.json`) calls the same script, so a local run fails the
same way CI would. Four more CI jobs: a build + bundle smoke test (single self-contained file,
starts quietly, `--version` matches) that used to run only on a tag in `release.yml` and now runs on
every PR and push too, from the same `scripts/smoke-bundle.sh` both workflows call — on Node 20 as
well as 24, since this job never touches vitest and Node 20 is the floor the shipped bundle actually
promises; `installer-scope`, on `windows-latest`, which runs `scripts/test-install-scope.ps1` under
both `pwsh` and Windows PowerShell 5.1 to prove that `irm | iex` leaves the caller's session as it
found it (`ErrorActionPreference`, `StrictMode`, variables, functions); `npm audit --omit=dev
--audit-level=high`, scoped to the two runtime dependencies (`commander`, `picocolors`) since the dev
toolchain's own advisories never reach anything homecoming installs or executes; and
`privacy-guard`. The coverage floor is not a separate job: it is enforced inside `check`.

`package.json` forces `esbuild` to `^0.28.1` through `overrides`: tsup 8.5 asks for `^0.27`, and
every 0.27 release from 0.27.3 on falls under advisory GHSA-g7r4-m6w7-qqqr. Remove the override once
tsup accepts 0.28.

`npm run coverage` measures `src/**/*.ts` including `src/cli/**` (excluding it made the number
optimistic — 88% became 66.6% once the CLI entrypoints were counted), and `vitest.config.ts` sets a
coverage floor with margin below the real level — measured coverage here is genuinely
environment-dependent, not just noisy: several code paths branch on what actually exists under the
home directory and on OS, and GitHub Actions' `ubuntu-latest` reads a few tenths of a point lower
across the board than a developer's own Windows machine or `windows-latest`. The floor sits under
the real low point of that range (`ubuntu-latest`), not under whichever environment was measured
most recently: a genuine drop still fails CI, an improvement is free to raise it, and the floor is
never lowered just to make a drop pass.

### Releasing

The version lives in five files — `package.json`, `package-lock.json` (which restates it twice, and
which `npm install` alone would leave reporting a version the release never had), `src/version.ts`
(stamped into every copy homecoming writes), `install.ps1` (which pins the release it downloads) and
`README.md` (the plugin tarball URL, `releases/download/vX.Y.Z/homecoming-X.Y.Z.tgz`).
`npm run version:set X.Y.Z` (`scripts/version.mjs`) bumps all five together, then tag:

```bash
npm run version:set 1.0.0
git commit -am "chore: release 1.0.0" && git tag -a v1.0.0 -m "homecoming v1.0.0"
git push && git push origin v1.0.0
```

Pushing the tag runs the release workflow, which refuses to publish unless the five versions agree
with each other and with the tag. It then builds the bundle, smoke-tests that it actually starts,
generates the SHA256 the installer verifies, and creates the release with four assets:
`homecoming.js`, `homecoming.js.sha256`, `install.ps1` and `homecoming-X.Y.Z.tgz` (from `npm pack`).
Run the workflow manually from the Actions tab to exercise all of that without publishing anything.
With the `publish` input turned on, a manual run publishes the release under the tag
`v<version from package.json>`, which `gh` creates at the commit that was built: an alternative to
pushing the tag yourself.

Before the first tag, create the `PRIVACY_DENYLIST` repository secret: the release workflow sets
`PRIVACY_REQUIRE_DENYLIST=1` and fails without it.

The installer runs its whole body inside its own script block, so `irm ... | iex` leaves nothing
behind in the calling session; `.\install.ps1 -Version vX.Y.Z -InstallDir <dir> -NoLaunch` still
works when the file is run directly.
