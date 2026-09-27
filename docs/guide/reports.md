# Reports: disk and stats

## Reports: where the bytes are, and where the tokens went

Two read-only commands, across the whole store — neither writes anything, and
neither decides what is safe to remove:

```bash
homecoming disk            # cards and transcripts: bytes per account folder, per project, and what is bulky
homecoming disk --json     # the same report, machine-readable

homecoming stats                        # token usage over the last 30 days, by model
homecoming stats --by week --since 90d  # a longer window, grouped by week
homecoming stats --json                 # the same report, machine-readable
```

`homecoming disk` measures every session card and every transcript this store can see: bytes per
account folder and per working directory, how much of a card's own JSON is bulky fields
(measured on a real store: 97%, nearly all of it `remoteMcpServersConfig`), transcripts no
card anywhere in the store still points at (broader than `purge`'s orphans — this counts one without
requiring a tombstone), transcript files that are byte-for-byte copies of each other (only
files that already share a size are hashed, and the hash itself streams a file rather than
reading it whole), and session cards already over the app's own 10 MB load limit. Measured on
a real store: five pairs of byte-identical transcripts, each pair a repository and a worktree
cut from it that never diverged after the branch was cut — exactly the "one conversation, two
files" shape `sweep` already knows about, seen here from the disk-usage side instead.

`homecoming stats` reads every transcript's assistant records for their own `usage` field (input,
output and cache tokens, and the model that produced them), aggregated per model or per week: a
single total hides where the tokens actually went, and one model or one week can carry most of it.
An error record the app writes in the model's place carries no real turn and is not counted. Reading a transcript a live session is
still appending to returns a snapshot, same as any other reader here — a re-run once the
session is idle sees the rest.
