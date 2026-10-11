/**
 * bookieMonster sync engine — platform-independent.
 *
 * Talks to X's internal GraphQL API with the signed-in session, discovers the
 * current bookmark query IDs, walks the bookmark and folder timelines, and
 * keeps a cumulative archive in a pluggable store. The Chrome service worker
 * and the Node test harness supply the HTTP and storage adapters.
 *
 * Response parsing is adapted from xarchive (MIT, (c) 2026 xarchive
 * contributors, https://github.com/sytelus/xarchive). Two behaviours differ
 * deliberately:
 *   - End of list: X ends a timeline with tweet-less pages or a repeated
 *     cursor. That is treated as completion, not as a pagination fault.
 *   - Query IDs: the bookmark operations live in lazily loaded webpack chunks;
 *     they are found through the chunk map embedded in the signed-in shell.
 */

export const OPERATIONS = ['Bookmarks', 'BookmarkFoldersSlice', 'BookmarkFolderTimeline'];

/** Public bearer token of the x.com web client (not user-specific). */
export const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const CHUNK_BASE = 'https://abs.twimg.com/responsive-web/client-web/';
const END_EMPTY_PAGES = 2;
const PAGE_DELAY_MS = [1500, 2500];
const TRANSIENT_RETRIES = 3;

/** Feature flags captured from live x.com requests; X-required extras are added at run time. */
const FEATURES = {
  graphql_timeline_v2_bookmark_timeline: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  responsive_web_media_download_video_enabled: false,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  longform_notetweets_consumption_enabled: true,
  view_counts_everywhere_api_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_grok_share_attachment_enabled: false,
};

export class AuthError extends Error { name = 'AuthError'; }
export class QueryError extends Error { name = 'QueryError'; }
export class RateLimitError extends Error {
  name = 'RateLimitError';
  constructor(resetAt) {
    super(`Rate limited until ${new Date(resetAt).toLocaleTimeString()}`);
    this.resetAt = resetAt;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pageDelay = () => sleep(PAGE_DELAY_MS[0] + Math.random() * (PAGE_DELAY_MS[1] - PAGE_DELAY_MS[0]));

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/**
 * @param {object} io
 * @param {(url: string, init: object) => Promise<Response>} io.fetch  fetch carrying the X session cookies
 * @param {() => Promise<string|null>} io.csrfToken  current ct0 cookie value
 */
export class XClient {
  constructor(io) {
    this.io = io;
    this.features = { ...FEATURES };
  }

  async getText(url) {
    const response = await this.io.fetch(url, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!response.ok) throw new Error(`HTTP ${response.status} loading ${url}`);
    return response.text();
  }

  async headers() {
    const ct0 = await this.io.csrfToken();
    if (!ct0) throw new AuthError('Not signed in to x.com (no ct0 cookie).');
    return {
      Authorization: `Bearer ${BEARER}`,
      'X-Csrf-Token': ct0,
      'X-Twitter-Auth-Type': 'OAuth2Session',
      'X-Twitter-Active-User': 'yes',
      'X-Twitter-Client-Language': 'en',
      'Content-Type': 'application/json',
    };
  }

  /** GET one GraphQL operation; retries transient failures, throws typed errors otherwise. */
  async graphql(queryId, operation, variables) {
    for (let attempt = 1; ; attempt++) {
      const params = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(this.features) });
      const url = `https://x.com/i/api/graphql/${encodeURIComponent(queryId)}/${operation}?${params}`;
      let response;
      try {
        response = await this.io.fetch(url, { headers: await this.headers() });
      } catch (err) {
        if (err instanceof AuthError || attempt >= TRANSIENT_RETRIES) throw err;
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const resetHeader = Number(response.headers.get('x-rate-limit-reset'));
      if (response.status === 429) throw new RateLimitError(resetHeader ? resetHeader * 1000 + 5000 : Date.now() + 15 * 60_000);
      if (response.status === 401 || response.status === 403) {
        throw new AuthError(`X rejected the session (HTTP ${response.status}). Open x.com and sign in.`);
      }
      const body = await response.text();
      if (response.status === 400 && body.includes('cannot be null')) {
        const missing = body.split('cannot be null')[1].match(/[a-z0-9_]{6,}/g) || [];
        if (missing.length && attempt < TRANSIENT_RETRIES) {
          for (const flag of missing) this.features[flag] = true;
          continue;
        }
      }
      if ([400, 404, 422].includes(response.status)) {
        throw new QueryError(`X rejected ${operation} (HTTP ${response.status}); query ID may be stale. ${body.slice(0, 200)}`);
      }
      if (!response.ok) {
        if (attempt >= TRANSIENT_RETRIES) throw new Error(`HTTP ${response.status} for ${operation}`);
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      const data = JSON.parse(body);
      if (data.errors?.some(e => e?.code === 88)) throw new RateLimitError(Date.now() + 15 * 60_000);
      if (data.errors?.length && !data.data) throw new Error(`X returned errors for ${operation}: ${JSON.stringify(data.errors).slice(0, 200)}`);
      return data;
    }
  }
}

// ---------------------------------------------------------------------------
// Session identity and query ID discovery
// ---------------------------------------------------------------------------

/** The signed-in app shell (x.com/i/bookmarks) names the viewer. */
export function parseIdentity(shellHtml) {
  const screenName = shellHtml.match(/"screen_name":"(\w+)"/)?.[1];
  const userId = shellHtml.match(/"id_str":"(\d+)"/)?.[1];
  return screenName ? { userId: userId || null, screenName } : null;
}

/**
 * Find the bookmark operation IDs. The shell embeds webpack's chunk map as
 * {id:"name"} and {id:"hash"} objects that build URLs as <name>.<hash>a.js;
 * the operations live in chunks whose names mention Bookmark.
 */
export async function discoverQueryIds(shellHtml, fetchText) {
  const builder = shellHtml.indexOf('+"a.js"');
  if (builder < 0) throw new QueryError('The x.com app shell no longer contains a chunk map.');
  const pairs = [...shellHtml.slice(0, builder).matchAll(/(\d+):"([^"]+)"/g)].map(m => [m[1], m[2]]);
  const hashes = new Map(pairs.filter(([, v]) => /^[0-9a-f]{16}$/.test(v)));
  const chunks = pairs.filter(([k, v]) => hashes.has(k) && v.includes('Bookmark'));
  const found = {};
  const sources = await Promise.all(chunks.map(([id, name]) =>
    fetchText(`${CHUNK_BASE}${name}.${hashes.get(id)}a.js`).catch(() => '')));
  for (const js of sources) {
    for (const m of js.matchAll(/queryId:["'`]([\w-]+)["'`],operationName:["'`](\w+)["'`]/g)) {
      if (OPERATIONS.includes(m[2]) && !found[m[2]]) found[m[2]] = m[1];
    }
  }
  const missing = OPERATIONS.filter(op => !found[op]);
  if (missing.length) throw new QueryError(`Query IDs not found for ${missing.join(', ')}.`);
  return found;
}

// ---------------------------------------------------------------------------
// Response parsing (adapted from xarchive lib/parser.js)
// ---------------------------------------------------------------------------

function getInstructions(data) {
  const d = data?.data || {};
  return d.bookmark_timeline_v2?.timeline?.instructions
    || d.bookmark_timeline?.timeline?.instructions
    || d.bookmark_collection_timeline?.timeline?.instructions
    || null;
}

/** @returns {{tweets: object[], cursor: string|null, unknown: number}} */
export function parsePage(data) {
  const instructions = getInstructions(data);
  if (!Array.isArray(instructions)) throw new Error(`Unrecognised timeline response: ${JSON.stringify(data).slice(0, 200)}`);
  const tweets = [];
  let cursor = null, unknown = 0;
  for (const ins of instructions) {
    const entries = ins?.type === 'TimelineReplaceEntry' ? [ins.entry] : ins?.entries || [];
    for (const entry of entries) {
      const id = entry?.entryId || '';
      if (id.startsWith('tweet-')) tweets.push(extractTweet(entry));
      else if (id.startsWith('cursor-bottom-')) cursor = entry.content?.value || null;
      else if (!id.startsWith('cursor-top-')) unknown++;
    }
  }
  return { tweets, cursor, unknown };
}

const unwrap = r => (r?.__typename === 'TweetWithVisibilityResults' ? r.tweet : r);
const isGone = r => !r || ['TweetTombstone', 'TweetUnavailable'].includes(r.__typename);

function unavailable(entry, reason) {
  return { tweet_id: entry.entryId.replace(/^tweet-/, ''), sort_index: entry.sortIndex || null,
           status: 'unavailable', unavailable_reason: reason, folders: [] };
}

function extractTweet(entry) {
  const result = unwrap(entry.content?.itemContent?.tweet_results?.result);
  if (!result) return unavailable(entry, 'No tweet data returned');
  if (isGone(result)) return unavailable(entry, result.tombstone?.text?.text || 'Tweet unavailable');
  return normalizeTweet(result, entry.sortIndex || null);
}

function userOf(result) {
  const core = result.core?.user_results?.result || {};
  return { core, legacy: core.legacy || {}, names: core.core || {} };
}

const noteOf = result => result.note_tweet?.note_tweet_results?.result || {};

function normalizeTweet(result, sortIndex) {
  const legacy = result.legacy || {};
  const { core, legacy: ul, names } = userOf(result);
  const note = noteOf(result);
  return {
    tweet_id: result.rest_id || legacy.id_str || '',
    sort_index: sortIndex,
    status: 'available',
    created_at: legacy.created_at || null,
    full_text: note.text || legacy.full_text || '',
    lang: legacy.lang || null,
    source: result.source || null,
    conversation_id: legacy.conversation_id_str || null,
    in_reply_to_tweet_id: legacy.in_reply_to_status_id_str || null,
    in_reply_to_user_id: legacy.in_reply_to_user_id_str || null,
    folders: [],
    author: {
      user_id: core.rest_id || ul.id_str || null,
      screen_name: names.screen_name || ul.screen_name || null,
      name: names.name || ul.name || null,
      profile_image_url: core.avatar?.image_url || ul.profile_image_url_https || null,
      verified: Boolean(core.is_blue_verified || ul.verified),
      followers_count: ul.followers_count || 0,
    },
    metrics: {
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      bookmarks: legacy.bookmark_count || 0,
      views: parseInt(result.views?.count, 10) || 0,
    },
    entities: extractEntities(note.entity_set ? { entities: note.entity_set } : legacy),
    media: extractMedia(legacy),
    quoted_tweet: extractQuoted(result),
    card: extractCard(result),
  };
}

function extractEntities(src) {
  const e = src.entities || {};
  return {
    urls: (e.urls || []).map(u => ({ url: u.url, expanded_url: u.expanded_url, display_url: u.display_url })),
    hashtags: (e.hashtags || []).map(h => h.text),
    mentions: (e.user_mentions || []).map(m => ({ screen_name: m.screen_name, user_id: m.id_str })),
  };
}

function extractMedia(legacy) {
  return ((legacy.extended_entities || legacy.entities || {}).media || []).map(m => {
    const item = { type: m.type, url: m.type === 'photo' ? `${m.media_url_https}?format=jpg&name=orig` : m.media_url_https,
                   alt_text: m.ext_alt_text || null };
    if (m.type === 'video' || m.type === 'animated_gif') {
      item.thumbnail_url = m.media_url_https;
      item.variants = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4')
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
        .map(v => ({ bitrate: v.bitrate || 0, content_type: v.content_type, url: v.url }));
      item.duration_ms = m.video_info?.duration_millis || null;
    }
    return item;
  });
}

function extractQuoted(result) {
  if (!result.quoted_status_result) return null;
  const q = unwrap(result.quoted_status_result.result);
  if (isGone(q)) return { tweet_id: null, status: 'unavailable', full_text: null, author: null };
  const legacy = q.legacy || {};
  const { legacy: ul, names } = userOf(q);
  return {
    tweet_id: q.rest_id || legacy.id_str || null,
    full_text: noteOf(q).text || legacy.full_text || null,
    author: { screen_name: names.screen_name || ul.screen_name || null, name: names.name || ul.name || null },
  };
}

function extractCard(result) {
  const card = result.card?.legacy;
  if (!card) return null;
  const b = {};
  for (const pair of card.binding_values || []) b[pair.key] = pair.value?.string_value || pair.value?.scribe_value?.description || null;
  return { type: card.name || null, url: b.card_url || b.url || null, title: b.title || null, description: b.description || null };
}

export function parseFolders(data) {
  const slice = data?.data?.viewer?.user_results?.result?.bookmark_collections_slice;
  if (!slice || !Array.isArray(slice.items)) throw new Error('Unrecognised folder list response.');
  return { folders: slice.items.map(i => ({ id: i.id || i.collection_id, name: i.name })),
           cursor: slice.slice_info?.next_cursor || null };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Walk a timeline until its end, or until onPage returns true.
 * X signals the end with tweet-less pages and/or a cursor it already gave.
 */
export async function paginate(client, queryId, operation, baseVars, startCursor, onPage, log) {
  let cursor = startCursor, emptyRun = 0, page = 0;
  const seen = new Set();
  for (;;) {
    const variables = cursor ? { ...baseVars, cursor } : { ...baseVars };
    const { tweets, cursor: next, unknown } = parsePage(await client.graphql(queryId, operation, variables));
    page++;
    if (unknown) log?.(`${operation} page ${page}: skipped ${unknown} unrecognised entr${unknown === 1 ? 'y' : 'ies'}.`);
    if (await onPage(tweets, next)) return;
    emptyRun = tweets.length ? 0 : emptyRun + 1;
    if (!next || emptyRun >= END_EMPTY_PAGES || (seen.has(next) && !tweets.length)) return;
    seen.add(next);
    cursor = next;
    await pageDelay();
  }
}

async function fetchFolderList(client, qids) {
  const folders = new Map();
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const page = parseFolders(await client.graphql(qids.BookmarkFoldersSlice, 'BookmarkFoldersSlice', cursor ? { cursor } : {}));
    for (const f of page.folders) folders.set(f.id, f);
    cursor = page.cursor;
    if (!cursor || seen.has(cursor)) return [...folders.values()];
    seen.add(cursor);
    await pageDelay();
  }
}

/**
 * Full mode resumes from the saved cursor and walks to the end. Incremental
 * mode starts at the newest bookmark and stops at the first page that holds
 * nothing new. Returns the number of new bookmarks.
 */
export async function scanBookmarks({ client, qids, store, log }, incremental) {
  const main = await store.getMeta('main', { cursor: null, status: 'pending' });
  if (!incremental && main.status === 'complete') return 0; // resumed after the list was finished
  const active = await store.activeIds();
  let added = 0;
  await paginate(client, qids.Bookmarks, 'Bookmarks', { count: 100, includePromotedContent: false },
    incremental ? null : main.cursor, async (tweets, next) => {
      const fresh = tweets.filter(t => !active.has(t.tweet_id));
      await store.putBookmarks(tweets); // also refreshes metrics and order of known ones
      for (const t of fresh) active.add(t.tweet_id);
      added += fresh.length;
      if (!incremental) {
        main.cursor = next;
        await store.setMeta('main', main);
        log?.(`Bookmarks: +${tweets.length} (total ${active.size}).`);
      }
      return incremental && tweets.length > 0 && fresh.length === 0;
    }, log);
  if (!incremental) await store.setMeta('main', { cursor: null, status: 'complete' });
  return added;
}

/**
 * Record folder membership; returns the number of new assignments.
 * Incremental mode reads each fully scanned folder from its newest entry until
 * a page holds nothing new; any other folder gets a full scan.
 */
export async function scanFolders({ client, qids, store, log }, incremental) {
  const folders = await fetchFolderList(client, qids);
  const members = await store.getMeta('folder_members', {});
  const status = await store.getMeta('folder_status', {});
  const current = new Set(folders.map(f => f.id));
  for (const fid of Object.keys(members)) if (!current.has(fid)) { delete members[fid]; delete status[fid]; }
  await store.setMeta('folders', folders);
  let added = 0;
  for (const folder of folders) {
    const fid = folder.id;
    if (!incremental && status[fid] === 'complete') continue;
    const list = members[fid] || (members[fid] = []);
    const known = new Set(list);
    const stopEarly = incremental && status[fid] === 'complete';
    await paginate(client, qids.BookmarkFolderTimeline, 'BookmarkFolderTimeline',
      { bookmark_collection_id: fid, count: 100, includePromotedContent: false }, null, async tweets => {
        const fresh = tweets.filter(t => !known.has(t.tweet_id));
        for (const t of fresh) { list.push(t.tweet_id); known.add(t.tweet_id); }
        // A folder can list a bookmark the main timeline omits (e.g. suspended accounts).
        await store.putBookmarks(tweets, { onlyIfMissing: true });
        added += fresh.length;
        await store.setMeta('folder_members', members);
        return stopEarly && tweets.length > 0 && fresh.length === 0;
      }, log);
    status[fid] = 'complete';
    await store.setMeta('folder_status', status);
    if (!stopEarly) log?.(`Folder "${folder.name}": ${list.length} bookmarks.`);
    await pageDelay();
  }
  return added;
}

/**
 * One sync pass: continue the initial backup until it completes, afterwards
 * pick up new bookmarks and folder assignments.
 * @returns {Promise<{changes: number, initialComplete: boolean}>}
 */
export async function syncOnce(ctx) {
  const { store, log } = ctx;
  if (!(await store.getMeta('initial_complete', false))) {
    log?.(`Initial backup: ${(await store.activeIds()).size} bookmarks so far.`);
    let changes = await scanBookmarks(ctx, false);
    log?.('All bookmarks collected; collecting folders.');
    changes += await scanFolders(ctx, false);
    await store.setMeta('initial_complete', true);
    log?.('Initial backup complete.');
    return { changes: changes + 1, initialComplete: true };
  }
  const added = await scanBookmarks(ctx, true);
  const assigned = await scanFolders(ctx, true);
  if (added || assigned) log?.(`Update: ${added} new bookmark(s), ${assigned} new folder assignment(s).`);
  return { changes: added + assigned, initialComplete: true };
}

// ---------------------------------------------------------------------------
// Archive and LLM outputs
// ---------------------------------------------------------------------------

/** Build the xarchive-compatible (schema 2) cumulative archive. */
export async function assembleArchive(store, identity, version) {
  const folders = (await store.getMeta('folders', null)) || [];
  const members = await store.getMeta('folder_members', {});
  const status = await store.getMeta('folder_status', {});
  const complete = await store.getMeta('initial_complete', false);
  const main = await store.getMeta('main', { status: 'pending' });
  const names = new Map(folders.map(f => [f.id, f.name]));
  const membership = new Map();
  for (const [fid, ids] of Object.entries(members)) for (const id of ids) {
    if (!membership.has(id)) membership.set(id, []);
    membership.get(id).push(fid);
  }
  const order = b => (/^\d+$/.test(b.sort_index || '') ? BigInt(b.sort_index) : 0n);
  const bookmarks = (await store.allBookmarks()).sort((a, b) => {
    const x = order(a), y = order(b);
    return x < y ? 1 : x > y ? -1 : 0; // newest-bookmarked first
  });
  for (const b of bookmarks) {
    b.folder_ids = membership.get(b.tweet_id) || [];
    b.folders = b.folder_ids.map(id => names.get(id) || id);
  }
  const current = bookmarks.filter(b => !b.removed_at);
  const available = current.filter(b => b.status === 'available').length;
  return {
    export_metadata: {
      tool: 'bookieMonster', schema_version: 2, kind: 'cumulative', version,
      exported_at: new Date().toISOString(),
      user_id: identity?.userId || null, screen_name: identity?.screenName || null,
      collection: {
        mode: complete ? 'full' : 'initial_in_progress',
        bookmarks: main.status === 'complete' ? 'complete' : 'partial',
        folders: complete ? 'complete' : 'partial',
        folder_contents: Object.fromEntries(folders.map(f => [f.id, status[f.id] || 'partial'])),
        reason: complete ? 'complete' : 'in_progress',
      },
      stats: { total_bookmarks: current.length, available_bookmarks: available,
               unavailable_bookmarks: current.length - available,
               removed_bookmarks: bookmarks.length - current.length, total_folders: folders.length },
    },
    folders,
    bookmarks,
  };
}

const TCO = /https?:\/\/t\.co\/\w+/g;
const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescapeHtml = s => s.replace(/&(amp|lt|gt|quot|#39);/g, m => HTML_ENTITIES[m]);

function cleanText(text, urls = []) {
  const expanded = new Map(urls.map(u => [u.url, u.expanded_url || u.url]));
  return unescapeHtml(text || '').replace(TCO, m => expanded.get(m) || '').replace(/[ \t]+\n/g, '\n').trim();
}

function isoDate(raw) {
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : raw || null;
}

/** Compact, LLM-friendly record for one bookmark (null for removed ones). */
export function toRecord(b) {
  if (b.removed_at) return null;
  if (b.status !== 'available') return { id: b.tweet_id, status: b.status, reason: b.unavailable_reason };
  const urls = b.entities?.urls || [];
  const handle = b.author?.screen_name || 'i';
  const rec = {
    id: b.tweet_id, url: `https://x.com/${handle}/status/${b.tweet_id}`, author: `@${handle}`,
    author_name: b.author?.name, date: isoDate(b.created_at), lang: b.lang, text: cleanText(b.full_text, urls),
  };
  if (urls.length) rec.links = urls.map(u => u.expanded_url || u.url);
  if (b.entities?.hashtags?.length) rec.hashtags = b.entities.hashtags;
  if (b.folders?.length) rec.folders = b.folders;
  if (b.in_reply_to_tweet_id) rec.reply_to = b.in_reply_to_tweet_id;
  if (b.quoted_tweet?.full_text) {
    rec.quoted = { author: b.quoted_tweet.author?.screen_name ? `@${b.quoted_tweet.author.screen_name}` : null,
                   text: cleanText(b.quoted_tweet.full_text) };
  }
  if (b.card?.title || b.card?.description) rec.card = Object.fromEntries(['title', 'description'].filter(k => b.card[k]).map(k => [k, b.card[k]]));
  if (b.media?.length) rec.media = b.media.map(m => (m.alt_text ? { type: m.type, alt: m.alt_text } : { type: m.type }));
  if (b.metrics?.likes) rec.likes = b.metrics.likes;
  if (b.metrics?.views) rec.views = b.metrics.views;
  return rec;
}

function recordMarkdown(r) {
  const lines = [`### ${r.author} · ${r.date}`, ''];
  if (r.folders) lines.push(`Folders: ${r.folders.join(', ')}`, '');
  if (r.text) lines.push(...r.text.split('\n').map(l => (l ? `> ${l}` : '>')), '');
  if (r.quoted) lines.push(`Quoting ${r.quoted.author || 'a post'}:`, ...r.quoted.text.split('\n').map(l => (l ? `>> ${l}` : '>>')), '');
  if (r.card) lines.push(`Link preview: ${Object.values(r.card).join(' — ')}`, '');
  for (const link of r.links || []) lines.push(`- ${link}`);
  if (r.media) {
    const alts = r.media.filter(m => m.alt).map(m => m.alt);
    lines.push(`- Media: ${r.media.map(m => m.type).join(', ')}${alts.length ? ` (${alts.join('; ')})` : ''}`);
  }
  lines.push(`- Source: ${r.url}`, '');
  return lines.join('\n');
}

/**
 * LLM-ready files: one JSONL record per bookmark and Markdown split into parts
 * of roughly maxTokens tokens (4 characters per token).
 * @returns {{name: string, text: string, type: string}[]}
 */
export function buildLlmFiles(archive, maxTokens = 100_000) {
  const records = archive.bookmarks.map(toRecord).filter(Boolean);
  const files = [{ name: 'bookmarks.jsonl', type: 'application/x-ndjson',
                   text: records.map(r => JSON.stringify(r)).join('\n') + '\n' }];
  const available = records.filter(r => r.text !== undefined);
  const meta = archive.export_metadata;
  const header = [
    `# X bookmarks of @${meta.screen_name}`, '',
    `Exported ${meta.exported_at} by bookieMonster ${meta.version}.`,
    `${available.length} available bookmarks, newest-bookmarked first; ${records.length - available.length} unavailable omitted.`,
  ];
  if (meta.collection.mode !== 'full') header.push('Note: the initial backup is still in progress; older bookmarks are missing.');
  if (archive.folders.length) header.push(`Folders: ${archive.folders.map(f => f.name).join(', ')}.`);
  const budget = maxTokens * 4;
  const parts = [];
  let current = [], size = 0;
  for (const r of available) {
    const block = recordMarkdown(r);
    if (current.length && size + block.length > budget) { parts.push(current); current = []; size = 0; }
    current.push(block);
    size += block.length + 1;
  }
  if (current.length) parts.push(current);
  parts.forEach((blocks, i) => files.push({
    name: `bookmarks_${String(i + 1).padStart(2, '0')}.md`, type: 'text/markdown',
    text: [...header, `Part ${i + 1} of ${parts.length}.`, '', '---', ''].join('\n') + blocks.join('\n'),
  }));
  return files;
}
