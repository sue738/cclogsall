/**
 * search.js — find the conversation you half-remember.
 *
 * An archive you cannot search is a graveyard. This walks the compressed
 * archive (and the live directory) without unpacking anything to disk:
 * each transcript is gunzipped in memory, reduced to the words a human
 * actually said or read, and scanned.
 *
 * What counts as "the conversation": user prompts and assistant text. Tool
 * results are excluded — they are file dumps and command output, so including
 * them makes every query match everything and buries the real hit.
 *
 * Zero dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** Human-readable text of one transcript entry, or '' if it isn't conversation. */
function entryText(e) {
  if (!e || (e.type !== 'user' && e.type !== 'assistant') || e.isMeta) return '';
  const c = e.message && e.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const p of c) {
    if (!p) continue;
    if (p.type === 'text' && p.text) parts.push(p.text);
    // tool_use inputs carry intent (the command, the query) — cheap and useful
    else if (p.type === 'tool_use' && p.input) {
      const v = p.input.command || p.input.pattern || p.input.query || p.input.description;
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join('\n');
}

/** Build a matcher. Plain queries are case-insensitive substring; /re/flags is a regex. */
function makeMatcher(query, opts = {}) {
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(query);
  if (m) {
    const re = new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i');
    return (s) => re.test(s);
  }
  if (opts.caseSensitive) return (s) => s.includes(query);
  const q = query.toLowerCase();
  return (s) => s.toLowerCase().includes(q);
}

/** A short window of text around the first match, collapsed to one line. */
function snippet(text, query, width = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(query);
  let i;
  if (m) {
    const hit = new RegExp(m[1], 'i').exec(flat);
    i = hit ? hit.index : 0;
  } else {
    i = flat.toLowerCase().indexOf(query.toLowerCase());
    if (i < 0) i = 0;
  }
  const start = Math.max(0, i - Math.floor(width / 3));
  const out = flat.slice(start, start + width);
  return (start > 0 ? '…' : '') + out + (start + width < flat.length ? '…' : '');
}

/** Every searchable transcript: archived (.jsonl.gz) plus live (.jsonl). */
function listSearchable(archiveDir, claudeDir) {
  const out = [];
  const walk = (dir, root, gz) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, root, gz);
      else if (e.isFile() && e.name.endsWith(gz ? '.jsonl.gz' : '.jsonl')) {
        out.push({ file: full, gz, rel: path.relative(root, full).replace(/\.gz$/, '') });
      }
    }
  };
  if (archiveDir) walk(path.join(archiveDir, 'projects'), path.join(archiveDir, 'projects'), true);
  if (claudeDir) walk(path.join(claudeDir, 'projects'), path.join(claudeDir, 'projects'), false);
  // live wins over archive for the same session — same content, no double hits
  const seen = new Set();
  return out.reverse().filter((f) => (seen.has(f.rel) ? false : seen.add(f.rel)));
}

// A transcript can exceed Node's max string length (~512MB) once decompressed —
// `buf.toString()` on the whole file throws. Everything below walks the buffer
// newline by newline so only one entry is ever a string.
const MAX_LINE_BYTES = 8 * 1024 * 1024; // a single entry larger than this is a dump, not conversation

/** Read one transcript's conversation lines with timestamps, from disk or gzip. */
function readEntries(f) {
  let buf;
  try { buf = fs.readFileSync(f.file); } catch (e) { return []; }
  if (f.gz) {
    try { buf = zlib.gunzipSync(buf); } catch (e) { return []; }
  }
  const out = [];
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start);
    if (nl === -1) nl = buf.length;
    const len = nl - start;
    if (len > 0 && len <= MAX_LINE_BYTES) {
      let e;
      try { e = JSON.parse(buf.toString('utf8', start, nl)); } catch (err) { e = null; }
      if (e) {
        const t = entryText(e);
        if (t) out.push({ role: e.type, ts: e.timestamp || null, text: t });
      }
    }
    start = nl + 1;
  }
  return out;
}

/**
 * Search transcripts.
 * @returns {Array} one entry per session: {rel, project, session, date, hits, first}
 */
function search(files, query, opts = {}) {
  const match = makeMatcher(query, opts);
  const limit = opts.limit || 20;
  const results = [];
  for (const f of files) {
    const entries = readEntries(f);
    if (!entries.length) continue;
    let hits = 0, first = null;
    for (const e of entries) {
      if (!match(e.text)) continue;
      hits++;
      if (!first) first = e;
    }
    if (!hits) continue;
    const parts = f.rel.split(path.sep);
    const project = (parts[0] || '').split('-').filter(Boolean).pop() || parts[0];
    const session = path.basename(f.rel, '.jsonl');
    const stamps = entries.map((e) => e.ts).filter(Boolean);
    results.push({
      rel: f.rel, project, session, archived: f.gz,
      date: stamps.length ? String(stamps[0]).slice(0, 10) : null,
      lastDate: stamps.length ? String(stamps[stamps.length - 1]).slice(0, 10) : null,
      hits,
      role: first.role,
      snippet: snippet(first.text, query),
    });
  }
  results.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.hits - a.hits);
  return { total: results.length, results: results.slice(0, limit) };
}

module.exports = { entryText, makeMatcher, snippet, listSearchable, readEntries, search };
