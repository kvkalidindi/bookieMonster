// Offline tests for the sync engine.  Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate, parsePage, scanBookmarks, assembleArchive, buildLlmFiles, discoverQueryIds } from '../extension/lib/engine.js';
import { MemoryStore } from './memory-store.mjs';

const tweet = (id, sortIndex) => ({
  entryId: `tweet-${id}`, sortIndex: String(sortIndex),
  content: { itemContent: { tweet_results: { result: {
    __typename: 'Tweet', rest_id: String(id),
    legacy: { full_text: `post ${id} &amp; more https://t.co/abc`, created_at: 'Fri May 25 18:31:05 +0000 2018', lang: 'en',
              entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/a' }] } },
    core: { user_results: { result: { rest_id: '9', core: { screen_name: 'someone', name: 'Some One' } } } },
  } } } },
});
const page = (tweets, cursor) => ({ data: { bookmark_timeline_v2: { timeline: { instructions: [{
  type: 'TimelineAddEntries',
  entries: [...tweets, ...(cursor ? [{ entryId: `cursor-bottom-${cursor}`, content: { value: cursor } }] : [])],
}] } } } });

/** A fake client serving numbered pages; page n holds the given tweets. */
function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    async graphql(_qid, _op, variables) {
      const n = variables.cursor ? Number(variables.cursor.slice(1)) : 0;
      calls.push(n);
      return pages[n] ?? page([], `c${n + 1}`);
    },
  };
}

test('an empty page with a repeated or fresh cursor ends the walk as complete', async () => {
  const client = fakeClient([page([tweet(3, 30), tweet(2, 20)], 'c1'), page([tweet(1, 10)], 'c2')]);
  const seen = [];
  await paginate(client, 'q', 'Bookmarks', {}, null, async tweets => { seen.push(...tweets.map(t => t.tweet_id)); }, null);
  assert.deepEqual(seen, ['3', '2', '1']);
  assert.deepEqual(client.calls, [0, 1, 2, 3]); // two empty pages (2 and 3) end it
});

test('incremental scan stops at the first page with nothing new', async () => {
  const store = new MemoryStore();
  await store.putBookmarks(parsePage(page([tweet(2, 20), tweet(1, 10)])).tweets);
  const client = fakeClient([page([tweet(4, 40), tweet(3, 30)], 'c1'), page([tweet(2, 20), tweet(1, 10)], 'c2')]);
  const added = await scanBookmarks({ client, qids: { Bookmarks: 'q' }, store }, true);
  assert.equal(added, 2);
  assert.deepEqual(client.calls, [0, 1]);
});

test('a resumed initial backup does not re-read a finished bookmark list', async () => {
  const store = new MemoryStore();
  await store.setMeta('main', { cursor: null, status: 'complete' });
  const client = fakeClient([page([tweet(1, 10)], 'c1')]);
  assert.equal(await scanBookmarks({ client, qids: { Bookmarks: 'q' }, store }, false), 0);
  assert.deepEqual(client.calls, []);
});

test('archive is ordered newest-bookmarked first and LLM files are clean', async () => {
  const store = new MemoryStore();
  await store.putBookmarks(parsePage(page([tweet(1, 10), tweet(2, 9007199254740993)])).tweets);
  await store.setMeta('folders', [{ id: 'f1', name: 'AI' }]);
  await store.setMeta('folder_members', { f1: ['1'] });
  const archive = await assembleArchive(store, { userId: '1', screenName: 'me' }, '1.0.0');
  assert.deepEqual(archive.bookmarks.map(b => b.tweet_id), ['2', '1']);
  assert.deepEqual(archive.bookmarks[1].folders, ['AI']);
  const [jsonl, md] = buildLlmFiles(archive);
  const first = JSON.parse(jsonl.text.split('\n')[0]);
  assert.equal(first.text, 'post 2 & more https://example.com/a');
  assert.match(md.text, /Folders: AI/);
});

test('query IDs are read from bookmark chunks named in the chunk map', async () => {
  const shell = 'x={1:"bundle.Bookmarks",2:"bundle.Home"}[e]+"."+{1:"0123456789abcdef",2:"fedcba9876543210"}[e]+"a.js"';
  const js = ['Bookmarks', 'BookmarkFoldersSlice', 'BookmarkFolderTimeline']
    .map((op, i) => `e.exports={queryId:"id${i}",operationName:"${op}",operationType:"query"}`).join(';');
  const fetched = [];
  const ids = await discoverQueryIds(shell, async url => { fetched.push(url); return js; });
  assert.deepEqual(ids, { Bookmarks: 'id0', BookmarkFoldersSlice: 'id1', BookmarkFolderTimeline: 'id2' });
  assert.deepEqual(fetched, ['https://abs.twimg.com/responsive-web/client-web/bundle.Bookmarks.0123456789abcdefa.js']);
});
