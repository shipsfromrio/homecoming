import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTranscriptRoots } from '../src/engine/lineage.js';
import { useProcessTable } from '../src/util/processes.js';

// Everything under src/store/configDirs.ts (configDirCandidates, inUseConfigDir,
// and the rest of what `clients`/`sweep` walk) defaults its `home` parameter to
// `os.homedir()`, which — unset — is this machine's real profile, with a real
// ~/.claude that a unit test has no business scanning.
// Pointed at a fresh, empty directory before any of that code has a chance to
// read the real one, every default-`home` call lands somewhere both isolated
// and fast instead. `os.homedir()` on win32 reads USERPROFILE (and HOME
// elsewhere), and every caller resolves it lazily — a default parameter
// evaluated per call, not cached at import time — so setting both here, before
// any test file's own imports run, is enough to redirect all of them. Measured
// 2026-09-24: the suite went from 30 s to 7 s for the same 1,631 green tests,
// and tests/interactive.test.ts alone from 22 s to 0.8 s. A test that needs a
// specific `home` still passes its own, same as before.
const FAKE_HOME = mkdtempSync(path.join(tmpdir(), 'homecoming-test-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

// The home directory is not the only way out to the real machine. The store
// resolver reads LOCALAPPDATA and APPDATA (the packaged and plain installs),
// the transcript and live-session readers read CLAUDE_CONFIG_DIR, the ledger,
// cache, backups and update-check cache read FOSTER_HOME, and the update check
// goes to the network unless told not to. Left inherited, a test that relied on
// a default read this machine's real Claude Desktop store and wrote to its real
// ledger directory — whatever the docs said about never touching one. Each is
// pointed at an empty directory under the fake home, or removed, before any
// test file's own imports run; a test that needs one sets its own.
process.env.LOCALAPPDATA = path.join(FAKE_HOME, 'AppData', 'Local');
process.env.APPDATA = path.join(FAKE_HOME, 'AppData', 'Roaming');
process.env.FOSTER_HOME = path.join(FAKE_HOME, '.foster');
process.env.FOSTER_NO_UPDATE_CHECK = '1';
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CLAUDE_USER_DATA_DIR;
delete process.env.HOMECOMING_UPDATE_REPO;

// Unit tests never walk the real Claude install. Tests that ask about branches
// pass their own tree to lineageAt / projectsDirs.
useTranscriptRoots([]);

// Nor do they read the real process table: the session registry checks a pid
// against what is running, and letting that reach the machine would spawn
// PowerShell per test file and make the answers depend on whoever is logged in.
// An empty table means "could not be read", which every caller treats as no
// evidence either way. Tests about identity pass their own rows.
useProcessTable([]);
