/**
 * install.js — settings.json への SessionStart フック登録(純関数+薄いIO)。
 * ユーザー設定を書き換えるため、差分提示と確認を必須にする(実書込は bin 側)。
 * cc-guard の install と同じ流儀。
 */
'use strict';

const MARKER = 'cclogsall';

/** フックコマンド。PATH 解決を優先し、焼き込みパスはフォールバック(cc-fleet の教訓) */
function hookCommand(nodePath, binPath) {
  return `command -v cclogsall >/dev/null 2>&1 && cclogsall backup --quiet || "${nodePath}" "${binPath}" backup --quiet || true`;
}

function isInstalled(settings) {
  const entries = (((settings || {}).hooks || {}).SessionStart) || [];
  return entries.some((e) => JSON.stringify(e).includes(MARKER));
}

/** settings に cclogsall の SessionStart フック(async)を加えた新オブジェクトを返す(冪等・非破壊) */
function withHook(settings, command) {
  if (isInstalled(settings)) return settings;
  const next = JSON.parse(JSON.stringify(settings || {}));
  next.hooks = next.hooks || {};
  next.hooks.SessionStart = next.hooks.SessionStart || [];
  next.hooks.SessionStart.push({
    matcher: '',
    hooks: [{ type: 'command', command, async: true, statusMessage: 'cclogsall: archiving transcripts…' }],
  });
  return next;
}

/** cclogsall のエントリを取り除いた新オブジェクトを返す */
function withoutHook(settings) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  if (next.hooks && Array.isArray(next.hooks.SessionStart)) {
    next.hooks.SessionStart = next.hooks.SessionStart.filter((e) => !JSON.stringify(e).includes(MARKER));
    if (next.hooks.SessionStart.length === 0) delete next.hooks.SessionStart;
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }
  return next;
}

module.exports = { MARKER, hookCommand, isInstalled, withHook, withoutHook };
