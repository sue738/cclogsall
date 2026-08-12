/**
 * keeper.js — アーカイブの中核ロジック。
 * 純関数(plan/diagnose/stats/diff/find)と薄いIO(list/archive/restore/manifest)を分離。
 * 実 ~/.claude には触れない設計: すべて claudeDir / outDir を引数で受ける。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DAY_MS = 86400000;
const DEFAULT_CLEANUP_DAYS = 30;

// ---------- IO: live 側の列挙 ----------

/**
 * ~/.claude/projects 相当を再帰走査して .jsonl の一覧を返す。
 * サブエージェントの transcript(<session>/subagents/*.jsonl 等)は深い階層にあり、
 * 実測で全体の7割超を占めるため、1階層スキャンでは大半を取りこぼす。
 */
function listLiveSessions(claudeDir) {
  const base = path.join(claudeDir, 'projects');
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          const rel = path.relative(base, full);
          out.push({ project: rel.split(path.sep)[0], file: e.name, rel, mtimeMs: st.mtimeMs, size: st.size });
        } catch (err) { /* 消えた等は無視 */ }
      }
    }
  };
  walk(base);
  return out;
}

// ---------- manifest ----------

function manifestPath(outDir) { return path.join(outDir, 'manifest.json'); }

function readManifest(outDir) {
  try { return JSON.parse(fs.readFileSync(manifestPath(outDir), 'utf8')); }
  catch (e) { return { version: 1, entries: {} }; }
}

function writeManifest(outDir, manifest) {
  fs.mkdirSync(outDir, { recursive: true });
  // tmp+rename: 書き込み中のクラッシュで manifest が壊れると次回フル再アーカイブになる
  const p = manifestPath(outDir);
  fs.writeFileSync(p + '.tmp', JSON.stringify(manifest, null, 1));
  fs.renameSync(p + '.tmp', p);
}

// ---------- 純関数 ----------

/** 増分バックアップ計画: mtime+size が manifest と一致すればスキップ */
function planBackup(live, manifest) {
  const entries = (manifest && manifest.entries) || {};
  const toArchive = [];
  let unchanged = 0;
  for (const item of live) {
    const prev = entries[item.rel];
    if (prev && prev.mtimeMs === item.mtimeMs && prev.size === item.size) unchanged++;
    else toArchive.push(item);
  }
  return { toArchive, unchanged };
}

/** 現状診断: 履歴の範囲・保持設定・次に消えるまでの日数 */
function diagnose({ live, settings, now }) {
  const period = Number((settings || {}).cleanupPeriodDays) || DEFAULT_CLEANUP_DAYS;
  if (!live.length) return { sessions: 0, period };
  const times = live.map((x) => x.mtimeMs);
  const oldest = Math.min(...times);
  const newest = Math.max(...times);
  const oldestAgeDays = (now - oldest) / DAY_MS;
  const expiresInDays = period - oldestAgeDays; // 負なら「次回起動で消える」状態
  const atRisk = live.filter((x) => period - (now - x.mtimeMs) / DAY_MS <= 7).length;
  return {
    sessions: live.length,
    period,
    oldestDate: new Date(oldest).toISOString().slice(0, 10),
    newestDate: new Date(newest).toISOString().slice(0, 10),
    spanDays: Math.max(1, Math.round((newest - oldest) / DAY_MS)),
    expiresInDays: Math.floor(expiresInDays),
    atRisk,
    longRetention: period >= 365,
  };
}

/** アーカイブ統計 */
function archiveStats(manifest) {
  const entries = Object.entries((manifest && manifest.entries) || {});
  if (!entries.length) return { sessions: 0, size: 0, gzSize: 0 };
  let size = 0, gzSize = 0, min = Infinity, max = -Infinity;
  for (const [, e] of entries) {
    size += e.size; gzSize += e.gzSize || 0;
    if (e.mtimeMs < min) min = e.mtimeMs;
    if (e.mtimeMs > max) max = e.mtimeMs;
  }
  return {
    sessions: entries.length, size, gzSize,
    oldestDate: new Date(min).toISOString().slice(0, 10),
    newestDate: new Date(max).toISOString().slice(0, 10),
  };
}

/** live と archive の差分(未アーカイブ/変更あり) */
function statusDiff(live, manifest) {
  const { toArchive, unchanged } = planBackup(live, manifest);
  const entries = (manifest && manifest.entries) || {};
  const newFiles = toArchive.filter((x) => !entries[x.rel]).length;
  return { pending: toArchive.length, newFiles, changed: toArchive.length - newFiles, unchanged };
}

/** session プレフィックスでアーカイブを検索。
 *  basename だけでなくパス各セグメントを見る: サブエージェント transcript は
 *  `<project>/<session-uuid>/subagents/<agent>.jsonl` にあり、basename 一致だけだと
 *  セッション本体1件しか返さず、復元が大半(実測7割超)を黙って漏らす。 */
function findInArchive(manifest, prefix) {
  return Object.keys((manifest && manifest.entries) || {})
    .filter((rel) => rel.split(path.sep).some((seg) => seg.startsWith(prefix)))
    .sort();
}

// ---------- IO: 圧縮・復元 ----------

function archivedPath(outDir, rel) { return path.join(outDir, 'projects', `${rel}.gz`); }

/** 1ファイルを gzip 圧縮してアーカイブへ。書き終えてから manifest エントリを返す */
function archiveFile(claudeDir, outDir, item) {
  const src = path.join(claudeDir, 'projects', item.rel);
  const dst = archivedPath(outDir, item.rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const gz = zlib.gzipSync(fs.readFileSync(src));
  const tmp = `${dst}.tmp`;
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, dst); // 中途半端な .gz を残さない
  return { mtimeMs: item.mtimeMs, size: item.size, gzSize: gz.length, archivedAt: new Date().toISOString() };
}

/**
 * アーカイブから復元。既存ファイルは上書きしない(スキップとして報告)。
 * @returns {restored: string[], skipped: string[]}
 */
function restoreSessions(outDir, claudeDir, rels, { toDir } = {}) {
  const restored = [], skipped = [];
  for (const rel of rels) {
    const src = archivedPath(outDir, rel);
    const dst = toDir ? path.join(toDir, rel) : path.join(claudeDir, 'projects', rel);
    if (fs.existsSync(dst)) { skipped.push(dst); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, zlib.gunzipSync(fs.readFileSync(src)));
    restored.push(dst);
  }
  return { restored, skipped };
}

/** settings.json を読む(無ければ {}) */
function readSettings(settingsPath) {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch (e) { return {}; }
}

module.exports = {
  DAY_MS, DEFAULT_CLEANUP_DAYS,
  listLiveSessions, readManifest, writeManifest, manifestPath,
  planBackup, diagnose, archiveStats, statusDiff, findInArchive,
  archivedPath, archiveFile, restoreSessions, readSettings,
};
