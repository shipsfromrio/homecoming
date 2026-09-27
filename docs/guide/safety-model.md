# Safety model

## Safety model

- **Reads and writes are separated.** The scanner never writes. All mutation goes through a single
  engine module, and every completed operation is appended to a ledger (`~/.foster/ledger.jsonl`) so
  it can be replayed in reverse. The write comes first and only a finished write is recorded: a
  ledger entry for a write that failed would mark the session as fostered for ever, with no file to
  show for it.
- **The originals are never modified.** Fostering only ever _adds_ a file to the current account's
  folder. There is no move, and no rewrite of anything under the old account.
- **One command destroys data, and it is the only one.** `purge` deletes conversations the app has
  already deleted the cards for, and nothing brings them back — no backup, no ledger copy, no undo.
  It is fenced off accordingly: candidates are limited to transcripts nothing on disk points at,
  and `--yes` alone will not run it. Every other command adds a file, removes one homecoming itself
  wrote, or rewrites one field of a card it records first, so that the step after a crash is always a
  command.
- **Adding is safe while the app runs; removing is the case that is not.** Every copy carries a
  session id the app has never seen, so a running app neither reads that file (it is past its one
  read) nor writes it (it only writes sessions it holds) — it is simply invisible until the app
  starts again. A copy the app _did_ load is different: it may be written back at any time, which
  would recreate a file `homecoming` had just deleted. So `return` refuses for copies that already
  existed when the app started, and offers to close it for you.
- **It will not put the same conversation in a sidebar twice.** An account can already have its own
  card for the conversation being fostered — made when that work was resumed while signed into it —
  and the fostering key cannot see that, because the origin is the _other_ account's card and has
  never been fostered before. The result was two live rows for one conversation, differing only in
  which account watched which part of it. Fostering now refuses, naming what is already there
  (including when it is archived, where the answer is to unarchive rather than duplicate), and
  `--session` still overrides. For pairs already on disk, `status` counts them and
  `homecoming return --duplicates` removes the copies. Note that a `↪ ` in a title no longer proves a row
  is homecoming's: the app carries the title over when it makes a card of its own from one.
- **Nor the same conversation under two identifiers.** The check above compares `cliSessionId`, which
  is the one field a branch changes — so for a while the pair it existed to prevent was arriving
  through the branch. One conversation is forked (see below), each half ends up in a different
  account, and fostering both puts two identical-looking rows in one sidebar with nothing to tell
  them apart. What a branch cannot change is the conversation it was forked from: the two transcripts
  share every record up to the moment they parted, so the first `uuid` in the file identifies the
  work rather than the file. Fostering compares that too, and refuses with `already has a branch`
  rather than pretending it is the same conversation — because it is not, quite. Each side holds
  turns the other never got, so read both before choosing; `--session` overrides, and for pairs
  already on disk `status` counts them and `homecoming return --branches` removes them.

  Refusing it is right for `homecoming foster`, and refusing it silently was not, because the account
  keeps whichever half reached it first. When the half being turned away is the one that carried
  on, the command weighs the two and says so — how many records each holds that the other does not
  — and names `homecoming consolidate`. The other direction gets no such line: skipping the half that
  stopped is simply correct, and a note under every refusal would bury the handful that matter.
  `homecoming sweep` does not refuse at all: it brings every branch as its own row, the branch that
  carried on under its title and the rest marked stale, so the account never keeps the wrong half
  by accident.

  Removal keeps one row per piece of work, always: a card homecoming did not write if there is one,
  otherwise the half that carried on after the fork — measured by the records it holds that no
  sibling holds, not by which file was written last, which the app moves whenever a card is opened.
  Reporting every row of a group is true of each and ruinous together, and would have taken the work
  out of the sidebar entirely.

- **One card may be rewritten, and only in one field.** `homecoming consolidate` moves a card onto the
  half of a fork that carried on, which is the single place homecoming writes to a file it did not
  create. It changes the pointer and the date and carries every other key through untouched; it
  refuses outright while an app holding the card is running, because a card in memory is written back
  from memory; it records where the card was, so `--undo` restores it without reading anything but
  the ledger; and it leaves a second card the _app_ made for the same work alone, reported rather
  than removed. It also refuses to collapse a fork whose halves are both substantial — see
  [When one conversation becomes two](two-file-conversations.md#when-one-conversation-becomes-two).

- **A copy is the same conversation, which is the point and the one hazard.** The copy carries the
  original's `cliSessionId`, so both rows open one transcript: work done in the copy is in the
  original's transcript too, and returning the copy loses none of it. What does not travel is
  the row itself — the app only writes the sessions of the account it is holding, so the original
  keeps the title and date it had when it was fostered until you open it. `status` marks a
  conversation that carried on, and `return` says so rather than letting an old date read as lost
  work. The hazard is only this: **a conversation can be continued in one place at a time**, and a
  second card opened while something else is writing it makes the app branch instead — a new
  transcript, a new id, and that card moved onto the branch. It takes two installations for two
  sidebars to be live at once, and `homecoming` warns about that. But it takes only a **running Code
  session** for a conversation to have a writer, and that needs no second installation at all: foster
  a session you are working in, switch account, open the copy, and the copy becomes a snapshot that
  stops at the moment you opened it while your work carries on where you left it. `homecoming` warns when
  a copy it is making has a live writer, before and after writing, in the command and in the menu —
  and names it, with the pid and the directory it was started in, because "finish there first" is not
  advice anyone can act on without knowing where _there_ is. A pid on its own would not carry that
  claim: Windows hands them back out, so a registry file left behind by a crash can name an unrelated
  process. The record keeps the creation time of the process that wrote it, and that is what homecoming
  checks, so the warning is about a writer that is actually there. When finishing is not possible,
  `homecoming live --stop <id>` ends the writer. That is a kill and says so: the CLI has no window to
  close politely, so whatever the session had not yet written is lost, while everything already in
  the transcript stays. It refuses the session homecoming is itself running in, for the same reason it
  refuses to close the app it is running inside.

  When it does happen, nothing is lost — both transcripts are on disk — and homecoming notices. A copy
  the app has repointed at another conversation is recognised rather than counted as still standing,
  and what happens next depends on **what it now holds**:

  - **A branch of the very work it was fostered for.** The card is still one row, still showing that
    work, and further along than the original — so homecoming follows it. The fostering goes on tracking
    the same file, with its pointer moved onto the branch, and the sweep says
    `the app branched it and the copy here follows the branch`. This is a fix, and the bug it fixes
    was homecoming's worst: the fostering used to be dropped, the next sweep found the origin session
    untracked, and it wrote a **second** copy of the half the card had just moved off. One
    conversation, two rows in one sidebar, created by the run that was meant to tidy up. Measured on
    a real store, every one of the six copies the app had branched came back as a duplicate row. The
    record of the move is deliberately not the one `consolidate --undo` reads: the app moved that
    card, not homecoming, and offering to put it back would promise something homecoming cannot honour — and
    where homecoming _had_ moved that card earlier, the app overtaking it ends the undo claim rather than
    leaving a stale one for `--undo` to act on.

    Tracking it again does not make it ordinary. A sweep-wide `homecoming return` skips it, because the
    conversation on that card was born from opening that row and usually has no other card anywhere:
    removing it would take the work out of every sidebar, and `restore` could not offer it back,
    since a file homecoming unlinks leaves no deletion marker for that scan to find. Naming it with
    `--session` still reaches it — the same line homecoming draws around a copy you deleted in the app.

  - **Anything else.** Then the copy really is gone as a copy — it is a working card for unrelated
    work — and the conversation it was made for can be fostered again instead of being refused as
    "already fostered" forever. The card itself is left exactly where it is: the app made it what it
    is now, and removing it would delete something you can see.

- **It never uses a credential.** No credential is extracted, kept, logged, used or sent, no cookie
  store is opened, and no one is signed in or out. One file it does read holds one: the app's
  `config.json` carries the app's cached sign-in token next to the id of the signed-in account.
  homecoming takes the account id and a few plain settings from that file and does not read the
  token, never its value. Whether a token entry is present is a plugin's question
  (`credentialProbes`); the core never looks. Nothing is sent anywhere but the release check below.
  The account name it shows comes from the profile the app itself cached for the signed-in account,
  read at rest.
- **It never ends the app behind your back.** Where a polite close would work (tray off) it uses one;
  where it would not, it says so and waits for an explicit yes rather than quietly escalating, and it
  names what that costs. `homecoming` refuses outright to close an app it is running inside — detected
  both from the process tree and from the environment the app stamps on the sessions it spawns,
  because an exited intermediate can break the first signal and the failure mode is killing the
  caller mid-write.
- **A copy shares one thing with its original: the conversation.** That is the point — it is what
  makes the copy open the real thing rather than an empty session — but it means the file is not
  private to either of them. `homecoming` only ever reads it. The app does write to it: renaming a
  session syncs the new title into the transcript, and its own import rewrites the file in place. So
  renaming a copy is not confined to the copy. Nothing is lost by it; it is simply not the isolation
  the word "copy" suggests, and you should know which part is shared.
- **Scheduled-task sessions are treated separately.** Sessions carrying a `scheduledTaskId` are not
  listed in the sidebar's recents and are excluded from ordinary fostering.
- **One request, and only about versions.** Because the install URL pins a tag, an install would
  never learn about later releases on its own. So `homecoming` asks GitHub for the latest release tag,
  at most once a day, and tells you when you are behind. It sends nothing beyond the request itself,
  gives up after 2.5s, and stays silent if it fails — being offline never slows anything down.
  Set `FOSTER_NO_UPDATE_CHECK=1` to turn it off.

### What is not supported

**Cowork sessions are not supported — but not for the reason this file used to give.** Earlier
versions said the Cowork list came from the server and so could never be restored locally. That was
wrong: `local-agent-mode-sessions/<accountUuid>/<organizationUuid>/local_<id>.json` is the
authoritative store, and the app builds the list by reading those folders, exactly as it does for
Code sessions.

So the mechanism probably transfers. It is not supported because it has not been established that it
_works_, and there are specific reasons to check rather than assume: a Cowork session owns a sandbox
whose state a copy does not carry, and the app picks between full and shortened directory names for
that tree, so writing into the wrong one would produce a copy it never reads. Until someone verifies
it end to end, this remains a Code-session tool — which is a different statement from the one that
was here before, and an honest one.
