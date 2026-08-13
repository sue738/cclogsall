# cclogsall ⛑

**Claude Code silently deletes your transcripts after 30 days. Keep yours.**

By default (`cleanupPeriodDays: 30`), every Claude Code startup deletes session
files older than 30 days — no warning, no trash, no undo. People found out the
hard way: [issue #62476](https://github.com/anthropics/claude-code/issues/62476),
[#62959](https://github.com/anthropics/claude-code/issues/62959),
[a Hacker News thread](https://news.ycombinator.com/item?id=48802300), and
[press coverage](https://www.theregister.com/ai-and-ml/2026/06/30/claude-code-users-complain-their-chat-records-are-being-mysteriously-wiped-out/5264673).
The usual fix is a settings one-liner and a hand-rolled rsync script. cclogsall
is that, done properly: compressed, incremental, restorable, and it tells you
what you're about to lose.

```
$ npx cclogsall

📦 your Claude Code history only goes back to 2026-07-07 (2,931 sessions, cleanupPeriodDays=30)
   ⚠ your oldest session will be deleted in 2 day(s); 214 session(s) expire within a week

run `cclogsall backup` to archive everything (compressed, incremental, local)
```

## Install / run

```bash
npx cclogsall              # run without installing (from npm)
npm install -g cclogsall   # or make it a command: cclogsall
```

```bash
npx cclogsall              # diagnose only — read-only, see what expires
npx cclogsall backup       # gzip mirror -> ~/.cclogsall (~10x smaller)
cclogsall status           # archive vs live
cclogsall search "B+tree"  # find the conversation you half-remember
cclogsall restore 657fb6c1 # bring an archived session back (never overwrites)
cclogsall install          # auto-backup on every session start (asks first)
```

`backup` is incremental (mtime+size) and idempotent — run it as often as you
like. Sessions deleted from `~/.claude` stay in the archive; that is the point.

## Search — an archive you can't search is a graveyard

```
$ cclogsall search "why B+tree"

2 conversation(s) match "why B+tree" — showing 2

2026-06-17  playground  a1c93f02  7 hits  [archived]
   …so why B+tree and not a plain B-tree for the index? — because the leaves are
   linked, range scans walk siblings instead of re-descending…

open one:  cclogsall restore a1c93f02 --to /tmp/recall
```

It searches the **compressed** archive and your live sessions in one pass, with
nothing unpacked to disk — 2,958 transcripts (1.4 GB compressed) in about six
seconds on a laptop. Plain queries are case-insensitive substrings; `/regex/`
works too.

Only what was *said* is searched — prompts and replies, plus the intent of tool
calls. Tool **results** are excluded on purpose: they're file dumps and command
output, so including them makes every query match everything and buries the
conversation you were looking for. Sessions still present in `~/.claude` are
searched live, so an archived copy never shows up as a duplicate hit.

## Why not just set `cleanupPeriodDays`?

Do that too (`{"cleanupPeriodDays": 3650}` in `~/.claude/settings.json`). But it
only stops the scheduled cleanup. It does not survive `rm -rf ~/.claude`, a
reinstall, a lost laptop, or a bug — an archive in a separate directory (that
your backup tool then picks up) does.

## ⚠ Secrets: read this before archiving

Anthropic's stated reason for the 30-day default is that transcripts can contain
API keys, passwords, and source code. **An archive preserves those too — and
removes the "at least it auto-deletes" mitigation.** Pair cclogsall with
Scan with [`ccleaks`](https://github.com/sue738/ccleaks) before you archive or share, and treat
`~/.cclogsall` with the same care as `~/.ssh`. Encryption at rest is not in
v1 (planned; for now rely on full-disk encryption).

## Security & trust

- Zero dependencies, no postinstall, no build step. ~650 lines total — read it.
- Local only: nothing leaves your machine, no network calls at all.
- `install` shows the exact settings.json diff and asks before writing.
- Restore never overwrites an existing session file.

## Honest limitations

- **Tested on macOS and Linux.** Reading, archiving, searching and restoring
  use `path.join`/`os.homedir()` and should work on Windows, but `install`
  writes a POSIX shell hook (`command -v ... >/dev/null`) that will not run
  there — set the SessionStart hook by hand instead. Untested either way.
- **Already-deleted sessions cannot be recovered.** cclogsall can only protect
  what still exists when you first run `backup`.
- Restoring resets the file date, so the cleanup clock starts fresh for that file.
- The diagnose numbers use file mtimes — close to, but not exactly, Claude Code's
  own cleanup bookkeeping.
- No encryption at rest in v1 (see above).

## In practice

```bash
# nightly incremental backup (cron)
0 3 * * * /usr/local/bin/cclogsall backup --quiet
# or: cclogsall install — runs on every session start, async, unnoticeable
```
