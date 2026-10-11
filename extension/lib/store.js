/**
 * IndexedDB persistence for the archive.
 *
 *   bookmarks  one record per bookmarked post, keyed by tweet_id
 *   meta       small key/value state: sync cursor, folders, membership,
 *              query IDs, schedule, settings and the activity log
 *
 * Every write commits immediately, so an interrupted sync loses at most the
 * page in flight.
 */

const DB_NAME = 'bookieMonster';
const DB_VERSION = 1;
const LOG_LIMIT = 300;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export class Store {
  constructor() {
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('bookmarks')) db.createObjectStore('bookmarks', { keyPath: 'tweet_id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    this.db = await request(req);
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }

  async getMeta(key, fallback = null) {
    const db = await this.open();
    const value = await request(db.transaction('meta').objectStore('meta').get(key));
    return value === undefined ? fallback : value;
  }

  async setMeta(key, value) {
    const db = await this.open();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    await done(tx);
  }

  async allBookmarks() {
    const db = await this.open();
    return request(db.transaction('bookmarks').objectStore('bookmarks').getAll());
  }

  /** IDs of bookmarks that are currently bookmarked (not marked removed). */
  async activeIds() {
    return new Set((await this.allBookmarks()).filter(b => !b.removed_at).map(b => b.tweet_id));
  }

  /** Upsert bookmarks; with onlyIfMissing, existing records are left untouched. */
  async putBookmarks(tweets, { onlyIfMissing = false } = {}) {
    if (!tweets.length) return;
    const db = await this.open();
    const tx = db.transaction('bookmarks', 'readwrite');
    const os = tx.objectStore('bookmarks');
    for (const t of tweets) {
      if (onlyIfMissing) os.add(t).onerror = e => { e.preventDefault(); e.stopPropagation(); };
      else os.put(t);
    }
    await done(tx);
  }

  async updateBookmark(id, change) {
    const db = await this.open();
    const tx = db.transaction('bookmarks', 'readwrite');
    const os = tx.objectStore('bookmarks');
    const current = await request(os.get(id));
    if (current) os.put(change(current));
    await done(tx);
    return Boolean(current);
  }

  async log(message) {
    const entries = await this.getMeta('log', []);
    entries.push({ t: Date.now(), m: message });
    await this.setMeta('log', entries.slice(-LOG_LIMIT));
  }
}
