// In-memory implementation of the Store interface used by the engine (tests only).
export class MemoryStore {
  constructor() {
    this.meta = new Map();
    this.bookmarks = new Map();
  }
  async getMeta(key, fallback = null) { return this.meta.has(key) ? structuredClone(this.meta.get(key)) : fallback; }
  async setMeta(key, value) { this.meta.set(key, structuredClone(value)); }
  async allBookmarks() { return [...this.bookmarks.values()].map(b => structuredClone(b)); }
  async activeIds() { return new Set([...this.bookmarks.values()].filter(b => !b.removed_at).map(b => b.tweet_id)); }
  async putBookmarks(tweets, { onlyIfMissing = false } = {}) {
    for (const t of tweets) if (!onlyIfMissing || !this.bookmarks.has(t.tweet_id)) this.bookmarks.set(t.tweet_id, structuredClone(t));
  }
  async log() {}
}
