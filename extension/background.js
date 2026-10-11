/**
 * bookieMonster service worker.
 *
 *   - Runs the initial full backup, retrying with backoff until it completes.
 *   - Afterwards syncs on a timer and immediately after bookmark activity seen
 *     on x.com (add, remove, file into or out of a folder).
 *   - Saves the archive and LLM-ready files to Downloads/bookieMonster/.
 *
 * All requests use the browser's own signed-in x.com session.
 */

import {
  XClient, parseIdentity, discoverQueryIds, syncOnce, assembleArchive, buildLlmFiles,
  AuthError, QueryError, RateLimitError,
} from './lib/engine.js';
import { Store } from './lib/store.js';

const VERSION = chrome.runtime.getManifest().version;
const store = new Store();
const TICK = 'tick';
const DEFAULT_SETTINGS = { intervalMin: 10, autoSave: true };
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;
const ACTIVITY_DELAY_MS = 4_000;
const WATCHED_OPS = new Set(['CreateBookmark', 'DeleteBookmark', 'bookmarkTweetToFolder', 'RemoveTweetFromBookmarkFolder']);

let running = null;     // the sync in progress, if any
let rerun = false;      // activity arrived during a sync: run again afterwards
let saveTimer = null;

async function log(message) {
  console.log('[bookieMonster]', message);
  await store.log(message);
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await store.getMeta('settings', {})) };
}

function setBadge(text, color = '#164999') {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function ensureSetup() {
  if (!(await chrome.alarms.get(TICK))) await chrome.alarms.create(TICK, { periodInMinutes: 1 });
  // Extension-originated API requests must look like x.com page requests.
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://x.com' },
        { header: 'Referer', operation: 'set', value: 'https://x.com/i/bookmarks' },
      ] },
      condition: { urlFilter: '|https://x.com/i/api/', initiatorDomains: [chrome.runtime.id],
                   resourceTypes: ['xmlhttprequest', 'other'] },
    }],
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureSetup();
  if (reason === 'install') chrome.runtime.openOptionsPage();
  requestSync('installed', { force: true });
});
chrome.runtime.onStartup.addListener(async () => { await ensureSetup(); requestSync('startup'); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === TICK) requestSync('timer'); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== 'background') return false;
  const handlers = {
    sync: () => requestSync('manual', { force: true }),
    save: () => saveOutputs(),
    settings: async () => { await store.setMeta('settings', { ...(await getSettings()), ...msg.settings }); },
  };
  Promise.resolve(handlers[msg.type]?.()).then(() => reply({ ok: true }), err => reply({ ok: false, error: err.message }));
  return true;
});

// ---------------------------------------------------------------------------
// Scheduling and retries
// ---------------------------------------------------------------------------

async function requestSync(reason, { force = false } = {}) {
  if (running) { if (reason !== 'timer') rerun = true; return running; }
  const schedule = await store.getMeta('schedule', {});
  const now = Date.now();
  if (!force) {
    if (now < (schedule.nextAttemptAt || 0)) return;
    const initialComplete = await store.getMeta('initial_complete', false);
    const { intervalMin } = await getSettings();
    if (initialComplete && reason === 'timer' && now - (schedule.lastSuccessAt || 0) < intervalMin * 60_000) return;
  }
  running = runSync(reason).finally(() => {
    running = null;
    if (rerun) { rerun = false; requestSync('activity'); }
  });
  return running;
}

async function runSync(reason) {
  setBadge('…');
  // Extension API calls keep the service worker alive during a long backup.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const schedule = await store.getMeta('schedule', {});
  try {
    await store.setMeta('schedule', { ...schedule, runningSince: Date.now(), lastReason: reason });
    const client = new XClient({
      fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
      csrfToken: async () => (await chrome.cookies.get({ url: 'https://x.com', name: 'ct0' }))?.value || null,
    });
    const shell = await client.getText('https://x.com/i/bookmarks');
    const identity = parseIdentity(shell);
    if (!identity) throw new AuthError('Not signed in to x.com in this browser. Open x.com and sign in.');
    const owner = await store.getMeta('identity', null);
    if (owner?.userId && identity.userId && owner.userId !== identity.userId) {
      throw new AuthError(`Signed in as @${identity.screenName}, but this archive belongs to @${owner.screenName}.`);
    }
    if (!owner) await store.setMeta('identity', identity);

    const ctx = { client, store, log, qids: await store.getMeta('qids', null) };
    const discover = async () => {
      ctx.qids = await discoverQueryIds(shell, url => client.getText(url));
      await store.setMeta('qids', ctx.qids);
      await log('Discovered current X query IDs.');
    };
    if (!ctx.qids) await discover();
    let result;
    try {
      result = await syncOnce(ctx);
    } catch (err) {
      if (!(err instanceof QueryError)) throw err;
      await log(`${err.message} Rediscovering.`);
      await discover();
      result = await syncOnce(ctx);
    }
    await store.setMeta('schedule', { lastSuccessAt: Date.now(), failures: 0, nextAttemptAt: 0, lastError: null, lastReason: reason });
    if (result.changes && (await getSettings()).autoSave) await saveOutputs();
    setBadge('');
  } catch (err) {
    const failures = (schedule.failures || 0) + 1;
    const nextAttemptAt = err instanceof RateLimitError
      ? err.resetAt
      : Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_CAP_MS);
    await store.setMeta('schedule', { ...schedule, runningSince: null, failures, nextAttemptAt,
                                      lastError: err.message, lastErrorAt: Date.now() });
    await log(`Sync failed: ${err.message} Next attempt at ${new Date(nextAttemptAt).toLocaleTimeString()}.`);
    setBadge('!', '#78716C');
  } finally {
    clearInterval(keepAlive);
  }
}

// ---------------------------------------------------------------------------
// Bookmark activity on x.com
// ---------------------------------------------------------------------------

const pendingRequests = new Map();

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.initiator !== 'https://x.com' || details.method !== 'POST') return;
  const op = details.url.match(/\/graphql\/[^/]+\/(\w+)/)?.[1];
  if (!WATCHED_OPS.has(op)) return;
  let variables = {};
  try {
    const bytes = details.requestBody?.raw?.[0]?.bytes;
    if (bytes) variables = JSON.parse(new TextDecoder().decode(bytes)).variables || {};
  } catch { /* body is optional; a sync covers the change */ }
  pendingRequests.set(details.requestId, { op, variables });
}, { urls: ['https://x.com/i/api/graphql/*'] }, ['requestBody']);

chrome.webRequest.onCompleted.addListener(details => {
  const activity = pendingRequests.get(details.requestId);
  pendingRequests.delete(details.requestId);
  if (activity && details.statusCode === 200) onBookmarkActivity(activity).catch(err => log(`Activity handling failed: ${err.message}`));
}, { urls: ['https://x.com/i/api/graphql/*'] });

chrome.webRequest.onErrorOccurred.addListener(details => pendingRequests.delete(details.requestId),
  { urls: ['https://x.com/i/api/graphql/*'] });

async function onBookmarkActivity({ op, variables }) {
  const tweetId = variables.tweet_id;
  const folderId = variables.bookmark_collection_id;
  if (!(await store.getMeta('initial_complete', false)) || !tweetId) {
    setTimeout(() => requestSync('activity'), ACTIVITY_DELAY_MS);
    return;
  }
  const members = await store.getMeta('folder_members', {});
  if (op === 'CreateBookmark') {
    await log(`Bookmark added on x.com (${tweetId}); syncing.`);
    setTimeout(() => requestSync('activity'), ACTIVITY_DELAY_MS);
  } else if (op === 'DeleteBookmark') {
    await store.updateBookmark(tweetId, b => ({ ...b, removed_at: new Date().toISOString() }));
    for (const ids of Object.values(members)) {
      const i = ids.indexOf(tweetId);
      if (i >= 0) ids.splice(i, 1);
    }
    await store.setMeta('folder_members', members);
    await log(`Bookmark removed on x.com (${tweetId}).`);
    saveSoon();
  } else if (op === 'bookmarkTweetToFolder' && folderId) {
    const list = members[folderId] || (members[folderId] = []);
    if (!list.includes(tweetId)) list.unshift(tweetId);
    await store.setMeta('folder_members', members);
    await log(`Bookmark ${tweetId} filed into a folder.`);
    const known = await store.updateBookmark(tweetId, b => b);
    if (known) saveSoon(); else setTimeout(() => requestSync('activity'), ACTIVITY_DELAY_MS);
  } else if (op === 'RemoveTweetFromBookmarkFolder' && folderId) {
    members[folderId] = (members[folderId] || []).filter(id => id !== tweetId);
    await store.setMeta('folder_members', members);
    await log(`Bookmark ${tweetId} removed from a folder.`);
    saveSoon();
  }
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if ((await getSettings()).autoSave) await saveOutputs().catch(err => log(`Saving failed: ${err.message}`));
  }, ACTIVITY_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Saving files to Downloads/bookieMonster/
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS'],
    justification: 'Create blob URLs so archive files can be saved with chrome.downloads.',
  });
}

function waitForDownload(id) {
  return new Promise(resolve => {
    const listener = delta => {
      if (delta.id === id && delta.state && delta.state.current !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(delta.state.current);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function saveOutputs() {
  const identity = await store.getMeta('identity', null);
  if (!identity) return;
  const archive = await assembleArchive(store, identity, VERSION);
  const files = [
    { name: `bookieMonster_${identity.screenName}.json`, type: 'application/json', text: JSON.stringify(archive, null, 2) },
    ...buildLlmFiles(archive),
  ];
  await ensureOffscreen();
  const previous = await store.getMeta('saved_files', {});
  const saved = {};
  try {
    for (const file of files) {
      const { url } = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blob', text: file.text, mime: file.type });
      const id = await chrome.downloads.download({ url, filename: `bookieMonster/${file.name}`, conflictAction: 'overwrite', saveAs: false });
      const state = await waitForDownload(id);
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', url });
      if (state !== 'complete') throw new Error(`Saving ${file.name} was ${state}.`);
      saved[file.name] = id;
    }
  } finally {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  // Markdown parts that no longer exist (e.g. after removals) are deleted.
  for (const [name, id] of Object.entries(previous)) {
    if (!(name in saved)) await chrome.downloads.removeFile(id).catch(() => {});
  }
  await store.setMeta('saved_files', saved);
  await store.setMeta('last_saved_at', Date.now());
  await log(`Saved ${files.length} files to Downloads/bookieMonster/.`);
}
