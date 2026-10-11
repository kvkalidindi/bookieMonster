import { assembleArchive } from './lib/engine.js';
import { Store } from './lib/store.js';

const store = new Store();
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString();
const time = t => (t ? new Date(t).toLocaleString() : 'never');

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ target: 'background', type, ...extra });
}

async function render() {
  const [identity, initialComplete, schedule, settings, folders, members, log, bookmarks] = await Promise.all([
    store.getMeta('identity', null), store.getMeta('initial_complete', false), store.getMeta('schedule', {}),
    store.getMeta('settings', {}), store.getMeta('folders', null), store.getMeta('folder_members', {}),
    store.getMeta('log', []), store.allBookmarks(),
  ]);

  $('account').textContent = identity ? `Archive for @${identity.screenName}` : 'Sign in to x.com in this browser to start the backup.';

  const current = bookmarks.filter(b => !b.removed_at);
  const filed = new Set(Object.values(members).flat());
  $('stat-bookmarks').textContent = fmt(current.length);
  $('stat-filed').textContent = fmt(current.filter(b => filed.has(b.tweet_id)).length);
  $('stat-folders').textContent = folders ? fmt(folders.length) : '—';
  $('stat-unavailable').textContent = fmt(current.filter(b => b.status !== 'available').length);
  $('stat-removed').textContent = fmt(bookmarks.length - current.length);

  // runningSince is cleared when a sync ends; a stale value means the worker was stopped mid-run.
  const syncing = Boolean(schedule.runningSince) && Date.now() - schedule.runningSince < 15 * 60_000;
  const failing = !syncing && Boolean(schedule.lastError) && (schedule.lastErrorAt || 0) >= (schedule.lastSuccessAt || 0);
  $('status-panel').classList.toggle('error', failing);
  if (failing) {
    $('status-line').textContent = initialComplete ? 'Last sync failed' : 'Initial backup interrupted';
    $('status-detail').textContent = `${schedule.lastError} Retrying automatically at ${new Date(schedule.nextAttemptAt).toLocaleTimeString()}.`;
  } else if (!initialComplete) {
    $('status-line').textContent = syncing ? 'Initial backup in progress' : 'Initial backup paused';
    $('status-detail').textContent = `${fmt(current.length)} bookmarks collected so far. The backup resumes automatically after any interruption.`;
  } else {
    $('status-line').textContent = syncing ? 'Syncing…' : 'Up to date';
    $('status-detail').textContent = `Last successful sync: ${time(schedule.lastSuccessAt)}.`;
  }

  const rows = (folders || []).map(f => el('tr', {}, el('td', {}, f.name), el('td', { className: 'r' }, fmt((members[f.id] || []).length))));
  $('folder-rows').replaceChildren(...(rows.length ? rows
    : [el('tr', {}, el('td', { colSpan: 2, className: 'muted' }, 'No folders yet.'))]));

  $('log').replaceChildren(...log.slice(-60).reverse()
    .map(e => el('li', {}, el('time', {}, new Date(e.t).toLocaleTimeString()), e.m)));

  if (document.activeElement !== $('set-interval')) $('set-interval').value = String(settings.intervalMin ?? 10);
  $('set-autosave').checked = settings.autoSave ?? true;
  $('btn-download').disabled = !identity;
  $('btn-save').disabled = !identity;
}

/** Build a DOM element; string children become text nodes. */
function el(tag, props, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

$('btn-sync').addEventListener('click', async () => {
  $('btn-sync').disabled = true;
  try { await send('sync'); } finally { $('btn-sync').disabled = false; render(); }
});
$('btn-save').addEventListener('click', async () => {
  const result = await send('save');
  if (!result?.ok) alert(`Saving failed: ${result?.error}`);
});
$('btn-download').addEventListener('click', async () => {
  const identity = await store.getMeta('identity', null);
  const archive = await assembleArchive(store, identity, chrome.runtime.getManifest().version);
  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `bookieMonster_${identity.screenName}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
$('btn-folder').addEventListener('click', () => chrome.downloads.showDefaultFolder());
$('set-interval').addEventListener('change', e => send('settings', { settings: { intervalMin: Number(e.target.value) } }));
$('set-autosave').addEventListener('change', e => send('settings', { settings: { autoSave: e.target.checked } }));

render();
setInterval(render, 2000);
