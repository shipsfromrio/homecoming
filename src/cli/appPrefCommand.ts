import type { Command } from 'commander';
import pc from 'picocolors';
import { hostedByDesktop } from '../engine/desktop.js';
import { restartCommandFromArgv } from '../engine/detach.js';
import { inspectApp } from '../engine/safety.js';
import { restartAround } from '../ops/restart.js';
import {
  appPrefWriteNotices,
  isGuardedPref,
  parsePrefValue,
  readAppPrefs,
  refuseGuarded,
  specOf,
  writeAppPref,
  type PrefReading,
  type PrefSpec,
} from '../store/appPrefs.js';
import type { StoreLayout } from '../domain/types.js';

/**
 * `homecoming app pref` — the app's own settings, read and written where the app
 * keeps them.
 *
 * Reading is the half that pays for itself immediately: several of these decide
 * what the app does to a Code session, and homecoming spent three releases guessing
 * at one of them. `ccMaxWarmWorktrees` and
 * `ccWorktreeReapAfterHours` are the pair that reaps the worktree a session is
 * sitting in; `ccBranchPrefix` names the branch it creates.
 *
 * Writing takes `--yes` and wants the app closed — it rewrites this file from
 * memory, so a write made underneath it can simply vanish. It refuses the
 * preferences the app puts in the way on purpose (permissions, consent records,
 * organization policy, compliance, approvals, trusted folders, private-network
 * access, computer control): those are decisions the app asks the signed-in
 * person to make on its own screen, and homecoming only reads them.
 *
 * `--restart` closes the app, writes, and starts it again, because "close the
 * app first" is an instruction a tool that can close the app should not be
 * handing back. `--set` takes more than one change, so a run that has to stop
 * the app stops it once.
 */
export function registerAppPref(
  app: Command,
  context: (command: Command) => { store: StoreLayout },
): void {
  app
    .command('pref [name] [value]')
    .summary("read or change Claude Desktop's own settings")
    .description(
      'Claude Desktop keeps its preferences in claude_desktop_config.json, under a ' +
        'top-level `preferences` object, with its own defaults underneath — so a ' +
        'setting nobody has touched is absent rather than written out.\n\n' +
        'With no name, lists what has been set. --all lists every preference this ' +
        'build knows, default included. With a name, reads one; with a name and a ' +
        'value, changes it.\n\n' +
        'The app reads this file at start-up and rewrites it from memory, so a change ' +
        'wants the app closed. --restart does that for you: closes it, writes, starts ' +
        'it again. --set can be repeated, so several changes cost one stop.\n\n' +
        'Three of them decide what the app does to a Code session: ccBranchPrefix ' +
        'names the branch a session creates, and ccMaxWarmWorktrees with ' +
        'ccWorktreeReapAfterHours decide when the worktree it is sitting in gets ' +
        'reaped.',
    )
    .option('--all', 'include preferences that have never been set')
    .option(
      '--set <name=value...>',
      'change one preference; repeatable, and applied in one stop of the app',
    )
    .option('--unset', 'remove the setting, letting the app default take over')
    .option('--restart', 'close the app around the change and start it again')
    .option('--json', 'machine-readable output')
    .option('--yes', 'actually write; without it nothing is changed')
    .action(async function (this: Command, name: string | undefined, value: string | undefined) {
      const { store } = context(this);
      const opts = this.opts<{
        all?: boolean;
        set?: string[];
        unset?: boolean;
        restart?: boolean;
        json?: boolean;
        yes?: boolean;
      }>();

      const changes = plannedChanges(name, value, opts.set, Boolean(opts.unset));

      if (changes.length === 0) {
        if (name === undefined) {
          listPrefs(store, Boolean(opts.all), Boolean(opts.json));
          return;
        }
        readOne(store, name, Boolean(opts.json));
        return;
      }

      // Everything is parsed and checked before the app is touched. A typo in the
      // third of three values must not be discovered with the app already closed.
      const planned = changes.map((change) => resolve(store, change));
      // The settings the app guards are refused before anything else happens:
      // see `PrefSpec.guard`. Checked on the whole batch, so one guarded name
      // among several stops the run with nothing written.
      refuseGuarded(planned.map((item) => item.name));

      if (!opts.yes) {
        // `--json` describes the same plan a write would report, under a
        // `dryRun` flag, rather than the plain-text preview this used to print
        // regardless of `--json` — the write path below had the identical gap.
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                dryRun: true,
                changes: planned.map((item) => ({
                  name: item.name,
                  from: item.from,
                  to: item.to,
                  unset: item.unset,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }
        for (const item of planned) {
          console.log(
            `Would set ${pc.bold(item.name)}: ${format(item.from)} -> ${format(item.to)}` +
              (item.unset ? pc.dim(' (back to the default)') : ''),
          );
        }
        console.log(pc.dim('Re-run with --yes to write.'));
        return;
      }

      const running = inspectApp(store).running;
      if (running && !opts.restart) {
        throw new Error(
          'Claude Desktop is running, and it rewrites this file from memory — a change written\n' +
            'now can be lost without warning. Add --restart to close it, write, and start it again.',
        );
      }

      // Closing the app from a session it is hosting kills the session part-way
      // through, which is why quitDesktop refuses. Say so before writing rather
      // than after: a change applied with the app up is a change that may not
      // survive, and the user would have no reason to suspect it.
      if (running && hostedByDesktop(process.env)) {
        throw new Error(
          'homecoming is running inside Claude Desktop, so it cannot close the app to make this\n' +
            'change stick. Run the same command from a terminal outside the app.',
        );
      }

      const written: Array<{
        name: string;
        from: unknown;
        to: unknown;
        unset: boolean;
        backup: string;
        notices?: string[];
      }> = [];
      const writeAll = (): void => {
        for (const item of planned) {
          const { write, backup } = writeAppPref(store, item.name, item.parsed, {
            ...(item.unset ? { unset: true } : {}),
          });
          // Registered notices speak after the write has landed, never before:
          // they describe a change, not a plan.
          const notices = appPrefWriteNotices(write, {
            store,
            guarded: isGuardedPref(write.name),
          });
          written.push({
            name: write.name,
            from: write.from,
            to: write.to,
            unset: Boolean(write.unset),
            backup,
            ...(notices.length > 0 ? { notices } : {}),
          });
          if (!opts.json) {
            console.log(
              `${pc.bold(write.name)}: ${format(write.from)} -> ${format(write.to)}` +
                (write.unset ? pc.dim(' (default)') : ''),
            );
            console.log(pc.dim(`  backup: ${backup}`));
            for (const notice of notices) console.log(pc.yellow(`  ${notice}`));
          }
        }
      };

      if (!running) {
        writeAll();
        if (opts.json) {
          console.log(JSON.stringify({ written, closed: false, restarted: false }, null, 2));
        } else {
          console.log(
            pc.dim('The app reads this at start-up; it will see the change when it opens.'),
          );
        }
        return;
      }

      // `--restart` from here on. Went through `quitDesktop` and `startDesktop`
      // by hand until this: a `writeAppPref` that threw after the app had
      // already quit left `startDesktop` never called, and the app closed with
      // nothing said about it; the tray refusal named "--terminate", a flag
      // this command has never had (that one belongs to "homecoming app restart");
      // and `startDesktop`'s own result was thrown away, so this printed "is
      // up" whether or not it actually was. `restartAround` is the one place
      // that already gets all three right, the same as `layout`/`view` do.
      const restart = await restartAround(
        store,
        true,
        restartCommandFromArgv(process.argv.slice(2)),
        async () => writeAll(),
      );
      // `restart.closed` is `restartAround`'s own account of whether the app
      // actually went down, set the instant `duringGap` becomes safe to run —
      // not a proxy like `written.length > 0`, which was wrong whenever the
      // very *first* write inside the gap was the one that threw: the app had
      // already been closed by then, but nothing had been pushed onto
      // `written` yet, so the old proxy reported `closed: false` over a gap
      // that had, in fact, opened.
      const closed = restart.closed;
      if (restart.done) {
        if (opts.json) {
          console.log(JSON.stringify({ written, closed, restarted: true }, null, 2));
        } else {
          console.log('Claude Desktop is up.');
        }
        return;
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              written,
              closed,
              restarted: false,
              error: restart.reason,
              command: restart.command,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(pc.yellow(restart.reason ?? 'The restart did not finish.'));
        console.log(`  ${restart.command}`);
      }
      process.exitCode = 1;
    });
}

export interface Change {
  name: string;
  value?: string;
  unset: boolean;
}

/**
 * What this invocation was asked to change, from either spelling.
 *
 * `--set name=value` exists so that several changes cost one stop of the app;
 * the positional pair stays because one change is the common case and
 * `homecoming app pref sidebarMode code` reads better than the flag.
 */
export function plannedChanges(
  name: string | undefined,
  value: string | undefined,
  sets: string[] | undefined,
  unset: boolean,
): Change[] {
  const changes: Change[] = [];
  if (name !== undefined && (value !== undefined || unset)) {
    changes.push({ name, unset, ...(value === undefined ? {} : { value }) });
  }
  for (const pair of sets ?? []) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      throw new Error(`--set wants name=value, not "${pair}".`);
    }
    changes.push({ name: pair.slice(0, at), value: pair.slice(at + 1), unset: false });
  }
  return changes;
}

export interface Planned extends Change {
  spec: PrefSpec;
  parsed: unknown;
  from: unknown;
  to: unknown;
}

export function resolve(store: StoreLayout, change: Change): Planned {
  const spec = specOf(change.name);
  if (!spec) {
    throw new Error(
      `"${change.name}" is not a preference this build knows about. Run "homecoming app pref --all" to see the list.`,
    );
  }

  let parsed: unknown;
  if (!change.unset) {
    const outcome = parsePrefValue(spec, change.value ?? '');
    if (!outcome.ok) throw new Error(`${change.name} ${outcome.reason}.`);
    parsed = outcome.value;
  }

  const before = readAppPrefs(store, true).find((p) => p.name === change.name);
  return {
    ...change,
    spec,
    parsed,
    from: before?.value,
    to: change.unset ? spec.fallback : parsed,
  };
}

function format(value: unknown): string {
  if (value === undefined) return pc.dim('(absent)');
  return JSON.stringify(value);
}

/**
 * The same value, cut down to something a list can hold.
 *
 * Several of these are maps keyed by account, or the whole sidebar state; one of
 * them printed in full is longer than the rest of the listing put together, and
 * it carries identifiers that have no business scrolling past on a shared
 * screen. The full value is one `homecoming app pref <name>` away, or `--json`.
 */
function short(value: unknown, width = 56): string {
  const text = format(value);
  if (value === undefined || text.length <= width) return text;
  const kind = Array.isArray(value) ? 'list' : 'object';
  const size = Array.isArray(value)
    ? `${value.length} item(s)`
    : `${Object.keys(value as object).length} key(s)`;
  return typeof value === 'object' && value !== null
    ? pc.dim(`(${kind}, ${size})`)
    : `${text.slice(0, width - 1)}…`;
}

function listPrefs(store: StoreLayout, all: boolean, json: boolean): void {
  const rows = readAppPrefs(store, all);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('No preference has been set; the app is running on its defaults.');
    console.log(pc.dim('homecoming app pref --all lists every one this build knows.'));
    return;
  }
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const row of rows) {
    const mark = row.spec.guard ? pc.yellow(' !') : '  ';
    const where = row.stored ? '' : pc.dim(' (default)');
    console.log(`${row.name.padEnd(width)}${mark} ${short(row.value)}${where}`);
  }
  console.log('');
  console.log(
    pc.dim(
      `${rows.filter((r) => r.stored).length} set, ${rows.length} listed` +
        (rows.some((r) => r.spec.guard)
          ? ' · ! marks a setting the app guards (read-only here)'
          : ''),
    ),
  );
}

function readOne(store: StoreLayout, name: string, json: boolean): void {
  const row: PrefReading | undefined = readAppPrefs(store, true).find((p) => p.name === name);
  if (!row) {
    throw new Error(
      `"${name}" is not a preference this build knows about. Run "homecoming app pref --all" to see the list.`,
    );
  }
  if (json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  console.log(`${row.name} ${format(row.value)}${row.stored ? '' : pc.dim(' (default)')}`);
  if (row.spec.choices) console.log(pc.dim(`  one of: ${row.spec.choices.join(', ')}`));
  if (row.spec.guard)
    console.log(pc.yellow('  the app guards this one on purpose; change it in the app, not here'));
}
