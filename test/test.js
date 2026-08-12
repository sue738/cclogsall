/** test.js — ccforever のテスト。実 ~/.claude に触れない(fixture のみ)・ロケール非依存。 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const K = require('../lib/keeper.js');
const I = require('../lib/install.js');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccforever-'));
const claudeDir = path.join(tmp, 'claude');
const out = path.join(tmp, 'archive');
const mk = (rel, content, ageDays) => {
  const f = path.join(claudeDir, 'projects', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  if (ageDays != null) {
    const t = new Date(Date.now() - ageDays * K.DAY_MS);
    fs.utimesSync(f, t, t);
  }
  return f;
};

console.log('== listLiveSessions ==');
mk('-home-u-proj1/aaaa1111.jsonl', '{"type":"user"}\n'.repeat(100), 28);
mk('-home-u-proj1/bbbb2222.jsonl', '{"type":"assistant"}\n'.repeat(50), 5);
mk('-home-u-proj2/cccc3333.jsonl', '{"type":"user"}\n'.repeat(10), 0.5);
mk('-home-u-proj2/ignore.txt', 'not a session', 1);
mk('-home-u-proj1/aaaa1111/subagents/agent-x1.jsonl', '{"type":"assistant"}\n'.repeat(20), 3);
const live = K.listLiveSessions(claudeDir);
ok('jsonl のみ・再帰で 4 件', live.length === 4 && live.every((x) => x.file.endsWith('.jsonl')));
ok('rel は project/file 形式', live.some((x) => x.rel === '-home-u-proj1/aaaa1111.jsonl'));
ok('★サブエージェント階層も拾う', live.some((x) => x.rel === '-home-u-proj1/aaaa1111/subagents/agent-x1.jsonl'));
ok('存在しない dir は空配列', K.listLiveSessions(path.join(tmp, 'nope')).length === 0);

console.log('== planBackup(増分判定) ==');
const empty = { version: 1, entries: {} };
const plan1 = K.planBackup(live, empty);
ok('初回は全件対象', plan1.toArchive.length === 4 && plan1.unchanged === 0);

console.log('== backup roundtrip ==');
const manifest = { version: 1, entries: {} };
for (const item of plan1.toArchive) manifest.entries[item.rel] = K.archiveFile(claudeDir, out, item);
K.writeManifest(out, manifest);
ok('gz が生成される', fs.existsSync(K.archivedPath(out, '-home-u-proj1/aaaa1111.jsonl')));
ok('gzSize < size(圧縮が効く)', manifest.entries['-home-u-proj1/aaaa1111.jsonl'].gzSize < manifest.entries['-home-u-proj1/aaaa1111.jsonl'].size);
const plan2 = K.planBackup(K.listLiveSessions(claudeDir), K.readManifest(out));
ok('2回目は全件スキップ(冪等)', plan2.toArchive.length === 0 && plan2.unchanged === 4);
fs.appendFileSync(path.join(claudeDir, 'projects', '-home-u-proj2/cccc3333.jsonl'), '{"type":"user"}\n');
const plan3 = K.planBackup(K.listLiveSessions(claudeDir), K.readManifest(out));
ok('変更ファイルだけ再対象', plan3.toArchive.length === 1 && plan3.toArchive[0].rel.includes('cccc3333'));

console.log('== restore(上書き拒否) ==');
const rels = K.findInArchive(K.readManifest(out), 'aaaa');
ok('★プレフィックス検索はサブエージェント分も含む', rels.length === 2 &&
  rels.some((r) => r.endsWith('aaaa1111.jsonl')) &&
  rels.some((r) => r.includes('aaaa1111/subagents/')));
ok('manifest 書き込みは atomic(.tmp を残さない)', !fs.existsSync(K.manifestPath(out) + '.tmp'));
const r1 = K.restoreSessions(out, claudeDir, rels);
ok('既存ファイルはスキップ', r1.restored.length === 0 && r1.skipped.length === 2);
fs.rmSync(path.join(claudeDir, 'projects', '-home-u-proj1/aaaa1111.jsonl'));
const r2 = K.restoreSessions(out, claudeDir, rels);
ok('消えたファイルだけ復元(サブエージェント分は既存なのでスキップ)', r2.restored.length === 1 &&
  r2.skipped.length === 1 && fs.existsSync(path.join(claudeDir, 'projects', '-home-u-proj1/aaaa1111.jsonl')));
ok('復元内容が一致', fs.readFileSync(path.join(claudeDir, 'projects', '-home-u-proj1/aaaa1111.jsonl'), 'utf8') === '{"type":"user"}\n'.repeat(100));
const alt = path.join(tmp, 'elsewhere');
const r3 = K.restoreSessions(out, claudeDir, rels, { toDir: alt });
ok('--to で別ディレクトリへ(サブエージェント分も)', r3.restored.length === 2 && r3.restored.every((f) => f.startsWith(alt)));

console.log('== diagnose ==');
// 復元で aaaa1111 の mtime が現在になっているので、28日前に戻してから診断する
{
  const t = new Date(Date.now() - 28 * K.DAY_MS);
  fs.utimesSync(path.join(claudeDir, 'projects', '-home-u-proj1/aaaa1111.jsonl'), t, t);
}
const now = Date.now();
const d = K.diagnose({ live: K.listLiveSessions(claudeDir), settings: { cleanupPeriodDays: 30 }, now });
ok('期間とセッション数', d.period === 30 && d.sessions === 4);
ok('★最古(28日前)の残り日数 ≒ 2', d.expiresInDays >= 1 && d.expiresInDays <= 2);
ok('1週間以内に消えるのは1件', d.atRisk === 1);
const d2 = K.diagnose({ live: K.listLiveSessions(claudeDir), settings: {}, now });
ok('設定なしは既定30日', d2.period === 30);
const d3 = K.diagnose({ live: K.listLiveSessions(claudeDir), settings: { cleanupPeriodDays: 3650 }, now });
ok('長期保持の判定', d3.longRetention === true);
ok('空でも落ちない', K.diagnose({ live: [], settings: {}, now }).sessions === 0);

console.log('== stats / status ==');
const st = K.archiveStats(K.readManifest(out));
ok('アーカイブ統計', st.sessions === 4 && st.gzSize > 0 && /^\d{4}-\d{2}-\d{2}$/.test(st.oldestDate));
const diff = K.statusDiff(K.listLiveSessions(claudeDir), K.readManifest(out));
ok('復元ファイルは mtime 変化で pending 扱い', diff.pending >= 1);

console.log('== install(純関数) ==');
const cmd = I.hookCommand('/usr/bin/node', '/x/bin/ccforever.js');
ok('PATH 優先+焼き込みフォールバック', cmd.includes('command -v ccforever') && cmd.includes('/x/bin/ccforever.js') && cmd.endsWith('|| true'));
const s0 = { permissions: { allow: ['Bash(git *)'] } };
const s1 = I.withHook(s0, cmd);
ok('既存設定を保持したまま追加', s1.permissions.allow[0] === 'Bash(git *)' && s1.hooks.SessionStart.length === 1);
ok('async フック', s1.hooks.SessionStart[0].hooks[0].async === true);
ok('冪等(二重追加しない)', I.withHook(s1, cmd).hooks.SessionStart.length === 1);
ok('isInstalled', I.isInstalled(s1) && !I.isInstalled(s0));
const s2 = I.withoutHook(s1);
ok('削除で元に戻る', !I.isInstalled(s2) && !s2.hooks);
const sOther = I.withoutHook({ hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'other-tool' }] }] } });
ok('他ツールのフックは残す', sOther.hooks.SessionStart.length === 1);

console.log('== CLI(環境変数で隔離) ==');
const BIN = path.join(__dirname, '..', 'bin', 'ccforever.js');
const env = Object.assign({}, process.env, {
  CCFOREVER_CLAUDE_DIR: claudeDir,
  CCFOREVER_SETTINGS: path.join(claudeDir, 'settings.json'),
  CCFOREVER_OUT: path.join(tmp, 'archive2'),
  CCFOREVER_LANG: 'en',
});
fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 30 }));
const diag = execFileSync('node', [BIN], { encoding: 'utf8', env });
ok('diagnose が期限を警告', diag.includes('goes back to') && /deleted in \d+ day/.test(diag));
const bk = execFileSync('node', [BIN, 'backup'], { encoding: 'utf8', env });
ok('backup が件数と圧縮率を報告', bk.includes('archived 4 session(s)') && bk.includes('MB'));
ok('backup 出力に機密スキャンの注意', /secrets verbatim/.test(bk));
const stat = execFileSync('node', [BIN, 'status'], { encoding: 'utf8', env });
ok('status が live/archive を対比', stat.includes('archive: 4 sessions') && stat.includes('live: 4 sessions'));
const js = JSON.parse(execFileSync('node', [BIN, 'status', '--json'], { encoding: 'utf8', env }));
ok('--json', js.archive.sessions === 4 && typeof js.diff.pending === 'number');
const ja = execFileSync('node', [BIN], { encoding: 'utf8', env: Object.assign({}, env, { CCFOREVER_LANG: 'ja' }) });
ok('ja ロケールで日本語', ja.includes('しか残っていません'));

console.log('== search(gzipのまま全文検索) ==');
{
  const S = require('../lib/search.js');
  const ent = (o) => JSON.stringify(o);

  // entryText: 会話だけを対象にする(tool_result を混ぜると全部ヒットして役に立たない)
  ok('user文字列', S.entryText({ type: 'user', message: { content: 'B+木の話' } }) === 'B+木の話');
  ok('assistantのtextブロック', S.entryText({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) === 'hi');
  ok('★tool_resultは対象外', S.entryText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'B+木' }] } }) === '');
  ok('tool_useの意図(command)は拾う',
    S.entryText({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'ls -la' } }] } }) === 'ls -la');
  ok('isMetaは除外', S.entryText({ type: 'user', isMeta: true, message: { content: 'x' } }) === '');

  // matcher: 素の語は大小無視の部分一致 / /re/ は正規表現
  ok('部分一致は大小無視', S.makeMatcher('kelly')('Kelly criterion') === true);
  ok('--case で大小を区別', S.makeMatcher('kelly', { caseSensitive: true })('Kelly') === false);
  ok('/regex/ 記法', S.makeMatcher('/人月|person-month/')('a person-month b') === true);
  ok('正規表現も既定は大小無視', S.makeMatcher('/KELLY/')('kelly') === true);

  ok('snippet: 一致箇所の周辺を返す', S.snippet('x'.repeat(200) + 'NEEDLE' + 'y'.repeat(200), 'NEEDLE').includes('NEEDLE'));
  ok('snippet: 改行を潰して1行に', !S.snippet('a\n\nb NEEDLE', 'NEEDLE').includes('\n'));

  // 実ファイル: 圧縮側とライブ側の両方
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccfsearch-'));
  const arch = path.join(sdir, 'archive', 'projects', '-h-old');
  const live = path.join(sdir, 'claude', 'projects', '-h-now');
  fs.mkdirSync(arch, { recursive: true }); fs.mkdirSync(live, { recursive: true });
  const body = [
    ent({ type: 'user', timestamp: '2026-06-01T00:00:00.000Z', message: { content: 'なぜ B+木 を使うのか' } }),
    ent({ type: 'assistant', timestamp: '2026-06-01T00:01:00.000Z', message: { content: [{ type: 'text', text: '葉が連結されているから' }] } }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(arch, 'deleted1.jsonl.gz'), zlib.gzipSync(Buffer.from(body)));
  fs.writeFileSync(path.join(live, 'current.jsonl'), body.replace('B+木', 'B-tree'));

  const files = S.listSearchable(path.join(sdir, 'archive'), path.join(sdir, 'claude'));
  ok('★圧縮とライブの両方を走査', files.length === 2 && files.some((f) => f.gz) && files.some((f) => !f.gz));
  const r1 = S.search(files, 'B+木');
  ok('★展開せずに圧縮ファイルを検索できる', r1.total === 1 && r1.results[0].archived === true);
  ok('日付とヒット数', r1.results[0].date === '2026-06-01' && r1.results[0].hits === 1);
  ok('ライブ側も検索できる', S.search(files, 'B-tree').total === 1);
  ok('該当なしは0件', S.search(files, 'ZZZZ').total === 0);
  ok('壊れた行があっても落ちない', (() => {
    fs.appendFileSync(path.join(live, 'current.jsonl'), '{"broken\n');
    return S.search(S.listSearchable(path.join(sdir, 'archive'), path.join(sdir, 'claude')), 'B-tree').total === 1;
  })());

  // 同一セッションが両方にある場合、ライブを優先(二重ヒットしない)
  const dupLive = path.join(sdir, 'claude', 'projects', '-h-old');
  fs.mkdirSync(dupLive, { recursive: true });
  fs.writeFileSync(path.join(dupLive, 'deleted1.jsonl'), body);
  const files2 = S.listSearchable(path.join(sdir, 'archive'), path.join(sdir, 'claude'));
  const r2 = S.search(files2, 'B+木');
  ok('★アーカイブとライブの重複を排除(ライブ優先)', r2.total === 1 && r2.results[0].archived === false);

  // CLI
  const searchEnv = Object.assign({}, process.env, {
    CCFOREVER_CLAUDE_DIR: path.join(sdir, 'claude'), CCFOREVER_OUT: path.join(sdir, 'archive'), CCFOREVER_LANG: 'en',
  });
  const so = execFileSync('node', [BIN, 'search', 'B+木'], { encoding: 'utf8', env: searchEnv });
  // 抜粋は「最初にヒットしたエントリ」= この場合ユーザーの問いかけ
  ok('CLI: search が件数と抜粋を出す', so.includes('1 conversation(s) match') && so.includes('なぜ B+木 を使うのか'));
  ok('CLI: 復元への導線', so.includes('ccforever restore'));
  const sj = JSON.parse(execFileSync('node', [BIN, 'search', 'B+木', '--json'], { encoding: 'utf8', env: searchEnv }));
  ok('CLI: search --json', sj.total === 1 && typeof sj.results[0].snippet === 'string');
  const sn = execFileSync('node', [BIN, 'search', 'ZZZZ'], { encoding: 'utf8', env: searchEnv });
  ok('CLI: 0件でも落ちない', sn.includes('no conversation matches'));

  fs.rmSync(sdir, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n結果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
