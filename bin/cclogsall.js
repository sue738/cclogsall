#!/usr/bin/env node
/**
 * cclogsall — Claude Code silently deletes your transcripts after 30 days. Keep yours.
 *
 * By default (cleanupPeriodDays: 30), every Claude Code startup deletes session
 * files older than 30 days — no warning, no trash, no undo. cclogsall mirrors
 * your transcripts into a compressed local archive, incrementally, so your
 * history survives the cleanup, reinstalls, and `~/.claude` accidents.
 *
 *   cclogsall                 diagnose: how far back does your history go?
 *   cclogsall backup          incremental gzip mirror -> ~/.cclogsall
 *   cclogsall status          archive vs live diff
 *   cclogsall restore <id>    bring an archived session back
 *   cclogsall install         auto-backup on every session start (with confirmation)
 *
 * Zero dependencies. Local only — nothing leaves your machine.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const K = require('../lib/keeper.js');
const I = require('../lib/install.js');
const S = require('../lib/search.js');

// 出力言語: 既定は英語、ロケールが日本語のときだけ日本語(CCLOGSALL_LANGで明示指定も可)
const JA = /^ja/i.test(process.env.CCLOGSALL_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const L = (en, ja) => (JA ? ja : en);

const HELP = `cclogsall — keep your Claude Code history beyond the silent 30-day cleanup

Usage:
  cclogsall                  diagnose: how far back your history goes, what expires next
  cclogsall backup           incremental compressed mirror of ~/.claude/projects
  cclogsall status           what's archived vs pending
  cclogsall restore <id>     restore a session by id prefix (never overwrites)
  cclogsall restore --all --to DIR   unpack the whole archive for analysis
                             (then: cchours --base-dir DIR)
  cclogsall search <query>   search every archived + live conversation
                             (plain text, or /regex/. --limit N, --json)
  cclogsall install          add a SessionStart hook that runs backup automatically
  cclogsall uninstall        remove that hook
Options:
  --out DIR       archive directory (default ~/.cclogsall, or CCLOGSALL_OUT)
  --to DIR        (restore) restore somewhere other than the live directory
  --quiet         minimal output (for hooks/cron)
  --yes           skip confirmation (install/uninstall)
  --json          machine-readable output

Archives include everything — secrets too. Scan before sharing them anywhere.`;

const CLAUDE_DIR = process.env.CCLOGSALL_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = process.env.CCLOGSALL_SETTINGS || path.join(CLAUDE_DIR, 'settings.json');

function parseArgs(argv) {
  const o = { args: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--all') o.all = true;
    else if (a === '--limit') o.limit = +argv[++i];
    else if (a === '--case') o.caseSensitive = true;
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    else if (!o.cmd && !a.startsWith('-')) o.cmd = a;
    else o.args.push(a);
  }
  return o;
}

const outDir = (o) => o.out || process.env.CCLOGSALL_OUT || path.join(os.homedir(), '.cclogsall');
const mb = (n) => (n / 1048576).toFixed(1);

function cmdDiagnose(o) {
  const live = K.listLiveSessions(CLAUDE_DIR);
  const d = K.diagnose({ live, settings: K.readSettings(SETTINGS), now: Date.now() });
  if (o.json) return console.log(JSON.stringify(d, null, 2));
  if (!d.sessions) return console.log(L('no sessions found under ', 'セッションが見つかりません: ') + CLAUDE_DIR);
  console.log(L(
    `📦 your Claude Code history only goes back to ${d.oldestDate} (${d.sessions} sessions, cleanupPeriodDays=${d.period})`,
    `📦 あなたの Claude Code 履歴は ${d.oldestDate} までしか残っていません(${d.sessions}セッション、cleanupPeriodDays=${d.period})`));
  if (d.longRetention) {
    console.log(L('   long retention is configured — but one rm -rf, reinstall, or lost laptop still erases everything',
      '   保持期間は延長済み — ただし誤削除・再インストール・マシン紛失では全て消えます'));
  } else if (d.expiresInDays <= 0) {
    console.log(L('   ⚠ your oldest sessions are past the limit — they will be deleted on the next Claude Code startup',
      '   ⚠ 最古のセッションは保持期限切れ — 次回の Claude Code 起動時に削除されます'));
  } else {
    console.log(L(`   ⚠ your oldest session will be deleted in ${d.expiresInDays} day(s); ${d.atRisk} session(s) expire within a week`,
      `   ⚠ 最古のセッションはあと${d.expiresInDays}日で削除されます(1週間以内に${d.atRisk}件が期限切れ)`));
  }
  console.log(L('\nrun `cclogsall backup` to archive everything (compressed, incremental, local)',
    '\n`cclogsall backup` で全履歴を圧縮アーカイブできます(増分・ローカル完結)'));
}

function cmdBackup(o) {
  const dir = outDir(o);
  const live = K.listLiveSessions(CLAUDE_DIR);
  const manifest = K.readManifest(dir);
  const { toArchive, unchanged } = K.planBackup(live, manifest);
  let size = 0, gzSize = 0;
  for (const item of toArchive) {
    try {
      manifest.entries[item.rel] = K.archiveFile(CLAUDE_DIR, dir, item);
      size += item.size; gzSize += manifest.entries[item.rel].gzSize;
    } catch (e) {
      if (!o.quiet) console.error(L(`  skip ${item.rel}: ${e.message}`, `  スキップ ${item.rel}: ${e.message}`));
    }
  }
  if (toArchive.length) K.writeManifest(dir, manifest);
  const st = K.archiveStats(manifest);
  if (o.json) return console.log(JSON.stringify({ archived: toArchive.length, unchanged, archive: st }, null, 2));
  if (o.quiet) return toArchive.length && console.log(`cclogsall: +${toArchive.length}`);
  console.log(L(
    `⛑ archived ${toArchive.length} session(s) (${unchanged} unchanged) — ${mb(size)} MB → ${mb(gzSize)} MB`,
    `⛑ ${toArchive.length}セッションをアーカイブ(${unchanged}件は変更なし) — ${mb(size)} MB → ${mb(gzSize)} MB`));
  console.log(L(`   archive total: ${st.sessions} sessions, ${st.oldestDate} → ${st.newestDate}, ${mb(st.gzSize)} MB on disk (${dir})`,
    `   アーカイブ合計: ${st.sessions}セッション、${st.oldestDate}〜${st.newestDate}、${mb(st.gzSize)} MB(${dir})`));
  console.log(L('   note: archives include secrets verbatim (API keys you pasted, tokens in output) — scan before sharing',
    '   注意: アーカイブには機密もそのまま含まれます(貼り付けたAPIキー等) — 共有前にスキャンを'));
}

function cmdStatus(o) {
  const dir = outDir(o);
  const live = K.listLiveSessions(CLAUDE_DIR);
  const manifest = K.readManifest(dir);
  const st = K.archiveStats(manifest);
  const diff = K.statusDiff(live, manifest);
  if (o.json) return console.log(JSON.stringify({ archive: st, diff }, null, 2));
  if (!st.sessions) return console.log(L('archive is empty — run `cclogsall backup`', 'アーカイブは空です — `cclogsall backup` を実行してください'));
  console.log(L(`archive: ${st.sessions} sessions, ${st.oldestDate} → ${st.newestDate}, ${mb(st.size)} MB → ${mb(st.gzSize)} MB on disk`,
    `アーカイブ: ${st.sessions}セッション、${st.oldestDate}〜${st.newestDate}、${mb(st.size)} MB → ${mb(st.gzSize)} MB`));
  console.log(L(`live: ${live.length} sessions — ${diff.pending} pending (${diff.newFiles} new, ${diff.changed} changed), ${diff.unchanged} up to date`,
    `ライブ: ${live.length}セッション — 未アーカイブ${diff.pending}件(新規${diff.newFiles}・変更${diff.changed})、最新${diff.unchanged}件`));
}

function cmdRestore(o) {
  const dir = outDir(o);
  const manifest = K.readManifest(dir);
  const prefix = o.args[0] || o.cmdArg;
  let rels;
  if (o.all) {
    // Whole archive: the point is feeding analysers (ccusage, cchours) a history
    // longer than cleanupPeriodDays left behind. Refuse to unpack thousands of
    // files over the live directory by accident — that path needs --to.
    rels = Object.keys(manifest.entries || {}).sort();
    if (!o.to) {
      console.error(L('restore --all needs --to DIR (restoring the whole archive over your live sessions is not what you want)',
        'restore --all には --to DIR が必要です(アーカイブ全体をライブ側へ戻すのは通常望ましくありません)'));
      console.error(L('  e.g. cclogsall restore --all --to /tmp/history && cchours --base-dir /tmp/history',
        '  例: cclogsall restore --all --to /tmp/history && cchours --base-dir /tmp/history'));
      process.exit(1);
    }
  } else {
    if (!prefix) { console.error(L('usage: cclogsall restore <session-id-prefix> | restore --all --to DIR', '使い方: cclogsall restore <セッションIDの先頭> または restore --all --to DIR')); process.exit(1); }
    rels = K.findInArchive(manifest, prefix);
    if (!rels.length) { console.error(L(`no archived session matches "${prefix}"`, `"${prefix}" に一致するアーカイブがありません`)); process.exit(1); }
  }
  const { restored, skipped } = K.restoreSessions(dir, CLAUDE_DIR, rels, { toDir: o.to });
  if (o.json) return console.log(JSON.stringify({ restored, skipped }, null, 2));
  if (o.all || o.quiet) {
    console.log(L(`restored ${restored.length} file(s), skipped ${skipped.length} (already present) → ${o.to}`,
      `${restored.length}件を復元、${skipped.length}件はスキップ(既存) → ${o.to}`));
    if (restored.length) {
      console.log(L('  read it with:  cchours --base-dir ' + o.to, '  読む:  cchours --base-dir ' + o.to));
      console.log(L(`  or:            CLAUDE_CONFIG_DIR=<parent-of-"projects"> ccusage daily`,
        `  または:        CLAUDE_CONFIG_DIR=<"projects"の親> ccusage daily`));
    }
  } else {
    for (const f of restored) console.log(L(`restored ${f}`, `復元: ${f}`));
    for (const f of skipped) console.log(L(`skipped (already exists): ${f}`, `スキップ(既存): ${f}`));
  }
  if (restored.length && !o.to) console.log(L('note: restoring resets the file date — the cleanup clock starts fresh',
    '注: 復元でファイル日付が新しくなるため、削除カウントは仕切り直しになります'));
}

function cmdSearch(o) {
  const query = o.args[0] || o.cmdArg;
  if (!query) { console.error(L('usage: cclogsall search <query>   (plain text, or /regex/)', '使い方: cclogsall search <検索語>  (プレーンテキスト または /正規表現/)')); process.exit(1); }
  const files = S.listSearchable(outDir(o), CLAUDE_DIR);
  const { total, results } = S.search(files, query, { limit: o.limit || 20, caseSensitive: o.caseSensitive });
  if (o.json) return console.log(JSON.stringify({ query, total, results }, null, 2));
  if (!total) return console.log(L(`no conversation matches "${query}" (${files.length} transcripts searched)`,
    `"${query}" に一致する会話はありません(${files.length}件を検索)`));
  console.log(L(`${total} conversation(s) match "${query}" — showing ${results.length}\n`,
    `"${query}" に一致: ${total}件(うち${results.length}件を表示)\n`));
  for (const r of results) {
    const where = r.archived ? L('archived', 'アーカイブ') : L('live', 'ライブ');
    console.log(`${r.date || '?'}  ${r.project}  ${r.session.slice(0, 8)}  ${r.hits}${L(' hits', '件')}  [${where}]`);
    console.log(`   ${r.snippet}\n`);
  }
  console.log(L(`open one:  cclogsall restore ${results[0].session.slice(0, 8)} --to /tmp/recall`,
    `復元する:  cclogsall restore ${results[0].session.slice(0, 8)} --to /tmp/recall`));
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim().toLowerCase()); }));
}

async function cmdInstall(o) {
  const settings = K.readSettings(SETTINGS);
  if (I.isInstalled(settings)) return console.log(L('already installed', '既にインストール済みです'));
  const command = I.hookCommand(process.execPath, path.resolve(__filename));
  const next = I.withHook(settings, command);
  console.log(L(`will add this SessionStart hook to ${SETTINGS}:`, `${SETTINGS} に以下の SessionStart フックを追加します:`));
  console.log('  ' + JSON.stringify(next.hooks.SessionStart[next.hooks.SessionStart.length - 1]));
  if (!o.yes) {
    const a = await ask(L('proceed? [y/N] ', '実行しますか? [y/N] '));
    if (a !== 'y' && a !== 'yes') return console.log(L('aborted', '中止しました'));
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + '\n');
  console.log(L('✅ installed — every session start now runs an incremental backup (async, non-blocking)',
    '✅ インストールしました — セッション開始のたびに増分バックアップが走ります(非同期)'));
}

async function cmdUninstall(o) {
  const settings = K.readSettings(SETTINGS);
  if (!I.isInstalled(settings)) return console.log(L('not installed', 'インストールされていません'));
  if (!o.yes) {
    const a = await ask(L('remove the cclogsall hook? [y/N] ', 'cclogsall のフックを削除しますか? [y/N] '));
    if (a !== 'y' && a !== 'yes') return console.log(L('aborted', '中止しました'));
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(I.withoutHook(settings), null, 2) + '\n');
  console.log(L('✅ uninstalled', '✅ 削除しました'));
}

async function main() {
  const o = parseArgs(process.argv);
  if (!o.cmd) return cmdDiagnose(o);
  if (o.cmd === 'backup') return cmdBackup(o);
  if (o.cmd === 'status') return cmdStatus(o);
  if (o.cmd === 'restore') return cmdRestore(o);
  if (o.cmd === 'search') return cmdSearch(o);
  if (o.cmd === 'install') return cmdInstall(o);
  if (o.cmd === 'uninstall') return cmdUninstall(o);
  console.log(HELP);
  process.exit(1);
}

main().catch((e) => { console.error('cclogsall:', e.message); process.exit(1); });
