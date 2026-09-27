# Install and usage (long form)

## Install

```powershell
irm https://github.com/shipsfromrio/homecoming/releases/latest/download/install.ps1 | iex
```

That URL always serves the installer from the newest release. The installer itself pins the tag it
was published from and verifies the downloaded bundle's SHA256 against that release's checksum
before running anything. To pin a version, fetch the installer by tag:
`https://raw.githubusercontent.com/shipsfromrio/homecoming/v1.0.0/install.ps1`.

When it finishes it opens the menu straight away; pass `-NoLaunch` to skip that. For development,
clone the repository and use `npm run dev -- <command>`.

## The menu

Run it with no arguments for a guided menu that stays open: tick the previous account to read from, choose
sessions, review, confirm, and carry on without relaunching.

```bash
homecoming
```

You do not have to close Claude Desktop first. When the copies are written it offers to restart the
app so they show up.

The source screen is ticked rather than chosen: the previous account, or one of its organizations.
Copies go to the account you are signed into; the confirmation names that destination and the
title prefix before anything is written.

Sessions can also come from another installation, given by path (`--from-store` on the command
line). It is a scan of its own rather than one more tick, and copies made that way record which
store they came from.

## One-shot commands

The same operations are available as commands, for scripting. `homecoming --help` files them under
these same headings:

```bash
# Start here
homecoming doctor      # check the environment before doing anything else
homecoming stores      # installations it knows about, and what to pass to --store

# Bringing conversations in
homecoming sweep       # everything into this account, archived and deleted included
homecoming scan        # read-only inventory of accounts and sessions
homecoming list        # sessions available to foster
homecoming foster      # copy sessions from another account into the current one
homecoming restore     # bring back sessions deleted in the app

# After the sweep
homecoming return      # remove fostered copies, restoring the previous state
homecoming consolidate # one row per piece of work, on the branch that carried on
homecoming unclaim     # release a worktree claim a copy inherited from its original
homecoming dates       # advance a card's date to its transcript's last answer
homecoming layout      # bring sidebar groups and routines into this account
homecoming view        # the Code sidebar's filter menu: show it, or change it
homecoming status      # what is currently fostered
homecoming pin         # pin sessions in the sidebar, or see what is pinned
homecoming purge       # destroy the conversations behind deleted sessions, with no undo
homecoming where <q>   # every card for one conversation, and which to continue in
homecoming verify      # after a restart, check nothing it wrote was undone

# Account folders
homecoming label       # give an account folder a human name
homecoming whoami      # the signed-in account's name and e-mail, from the app's own cache
homecoming labels      # the labels you have given

# Live sessions
homecoming grep <re>   # search every transcript by what was said
homecoming export <id> # one conversation as Markdown, HTML or JSONL
homecoming live        # conversations a claude process holds open right now
homecoming rescue      # conversations stranded by a crash
homecoming revive      # sessions a restart cut off or a usage limit stopped

# Reports
homecoming disk        # where the bytes are
homecoming stats       # token usage and sessions, from the transcripts

# The app
homecoming app status|quit|start|restart
```

Every command that writes is a dry run until you pass `--yes`, and most take `--json`.

## Naming account folders

Account folders are named by UUID. `homecoming label` gives one a name you choose; a label always
wins. Failing that, the signed-in account is named by the e-mail the app cached for its own profile,
read at rest from the app's HTTP response cache or web storage and never over the network.
`homecoming label --from-cache` turns that into a label in one step.

## `--store`

`--store` and `--from-store` take a directory, the name a store provider gave an installation, an
account label or unique UUID prefix, or a distinctive piece of a known path: `--store work` finds
`D:\Claude-Work` when that is a known installation. A piece that matches two of them is reported
rather than guessed at, and one that matches nothing and is not a directory is an error rather than
an empty store.

## State and the network

Everything homecoming keeps for itself lives under `~/.foster` (the name predates the rename, and is
kept so an existing ledger is found where it is), or under `FOSTER_HOME` when that is set: the
append-only ledger, the scan cache, backups, detached-run logs and UI preferences. The only network
request is a daily check of the latest release tag, which `FOSTER_NO_UPDATE_CHECK=1` turns off;
`HOMECOMING_UPDATE_REPO=owner/name` points it at a fork.

### A scheduled task's conversation

A scheduled task is excluded for a reason that turns out to be narrower than it looks. What the app
refuses to list under Recents is the **card**, because it carries a `scheduledTaskId`; the
conversation behind it is an ordinary transcript. So a copy of one is only invisible if it keeps
that field — and `--include-scheduled` drops it, along with giving the copy a focus time, since a
card without one counts as never opened and is the other way to be correct and invisible.

It is opt-in because the copy is not the task. The schedule, its trigger and its history stay in
the account that owns them, and nothing runs again; what crosses is the reading of what it did.
That is a different thing from what the row meant in its own account, so it is asked for rather
than swept up. The original is left untouched, still a scheduled task where it belongs.

### A copy can be the last card its conversation has

Copies are not sources. Fostering one would make a second copy of a conversation whose original is
right there, with a longer provenance chain and nothing gained. That rule is right until the
original stops existing — deleted in the app, or never there at all because the copy came from
`restore` — and then it strands the conversation: it sits in one account, perfectly readable, and no
sweep will ever offer it again.

So the rule is about the conversation rather than the file. A copy is refused while its conversation
still has a card of its own **somewhere in the store**, and is a legitimate source once it does not.
That question can only be answered by looking at every account folder, including the ones not being
