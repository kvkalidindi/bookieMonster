// Live check of the engine against a real X session, outside Chrome.
//
// Needs X_AUTH_TOKEN and X_CT0 (x.com cookies) in the environment. Optionally
// REFERENCE_STATE points at an existing archive state (bookmarks keyed by id,
// folders, folder_members, ...) to compare parsing and to exercise an
// incremental sync. Sends about ten read-only requests.  Run: npm run test:live
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { XClient, parseIdentity, discoverQueryIds, parsePage, syncOnce, assembleArchive, buildLlmFiles } from '../extension/lib/engine.js';
import { MemoryStore } from './memory-store.mjs';

function secret(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return '';
  try { // Windows user environment, without echoing the value
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8' });
    return out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(\\S+)`))?.[1] || '';
  } catch { return ''; }
}

const authToken = secret('X_AUTH_TOKEN'), ct0 = secret('X_CT0');
if (!authToken || !ct0) { console.error('Set X_AUTH_TOKEN and X_CT0.'); process.exit(2); }

let requests = 0;
const client = new XClient({
  csrfToken: async () => ct0,
  fetch: (url, init = {}) => {
    if (url.includes('/i/api/')) requests++;
    return fetch(url, { ...init, headers: { ...init.headers, Cookie: `auth_token=${authToken}; ct0=${ct0}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
      Origin: 'https://x.com', Referer: 'https://x.com/i/bookmarks' } });
  },
});

const shell = await client.getText('https://x.com/i/bookmarks');
const identity = parseIdentity(shell);
assert.ok(identity, 'session not recognised');
console.log(`Signed in as @${identity.screenName} (${identity.userId}).`);
const qids = await discoverQueryIds(shell, url => client.getText(url));
console.log('Query IDs:', qids);

const first = parsePage(await client.graphql(qids.Bookmarks, 'Bookmarks', { count: 100, includePromotedContent: false }));
console.log(`First page: ${first.tweets.length} bookmarks, cursor ${first.cursor ? 'present' : 'absent'}.`);
assert.ok(first.tweets.length > 0);

const refPath = process.env.REFERENCE_STATE;
if (refPath && existsSync(refPath)) {
  const ref = JSON.parse(readFileSync(refPath, 'utf8'));
  // Parsing parity: identical fields apart from live counters.
  const volatile = b => { const c = structuredClone(b); delete c.metrics; delete c.author?.followers_count; delete c.author?.profile_image_url; delete c.folders; delete c.folder_ids; return c; };
  let compared = 0;
  for (const t of first.tweets) {
    if (!ref.bookmarks[t.tweet_id]) continue;
    assert.deepEqual(volatile(t), volatile(ref.bookmarks[t.tweet_id]), `field mismatch for ${t.tweet_id}`);
    compared++;
  }
  console.log(`Parser parity: ${compared} records identical to the reference.`);

  // Incremental sync on a store seeded with the reference archive.
  const store = new MemoryStore();
  await store.putBookmarks(Object.values(ref.bookmarks));
  for (const key of ['folders', 'folder_members', 'folder_status', 'main']) await store.setMeta(key, ref[key]);
  await store.setMeta('initial_complete', true);
  requests = 0;
  const lines = [];
  const result = await syncOnce({ client, qids, store, log: m => lines.push(m) });
  console.log(`Incremental sync: ${result.changes} change(s) in ${requests} requests.`, lines.join(' | '));
  const archive = await assembleArchive(store, identity, 'test');
  const files = buildLlmFiles(archive);
  console.log(`Archive: ${archive.export_metadata.stats.total_bookmarks} bookmarks; ` +
    `${archive.bookmarks.filter(b => b.folder_ids.length).length} in a folder; ` +
    `${files.length} LLM files (${files.map(f => f.name).join(', ')}).`);
}
console.log('Live check passed.');
