# bookieMonster

bookieMonster mines the bookmarks in your X account and turns them into a knowledge base you can query. Version 1 is a Chrome extension. It keeps a complete, current archive of your bookmarks, including folder assignments, and saves files ready to load into an LLM. A bot interface on top of that knowledge base is planned.

## What it does

- **Complete initial backup.** Reads every bookmark and every bookmark folder from your signed-in x.com session. Progress is saved after every page. Interruptions such as a closed browser, a lost network connection or rate limits are retried automatically with backoff, up to 30 minutes between attempts, until the backup is complete.
- **Stays current.** After the initial backup, the archive updates within seconds when you add a bookmark, remove one, or move one into or out of a folder on x.com in the same browser. A timed check, every 10 minutes by default, catches changes made on other devices.
- **Folders included.** Records every folder each bookmark belongs to. X allows a bookmark in more than one folder.
- **LLM-ready output.** After every change, bookieMonster writes these files to `Downloads/bookieMonster/`:

| File | Contents |
|---|---|
| `bookieMonster_<handle>.json` | Full archive with author, text, links, media, quoted posts, link cards, metrics and folders, newest-bookmarked first. Uses the xarchive schema version 2. |
| `bookmarks.jsonl` | One compact record per bookmark, for retrieval and embeddings. |
| `bookmarks_NN.md` | Readable Markdown, split into parts of about 100,000 tokens each. |

Short links (`t.co`) are expanded and HTML entities are decoded. Posts that are no longer available are listed in the JSON and JSONL files, and left out of the Markdown.

## Install

**From the Chrome Web Store:** see the listing once it is published.

**From a release:**

1. Download `bookieMonster-<version>.zip` from [Releases](https://github.com/kvkalidindi/bookieMonster/releases) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.
4. Sign in to x.com in the same Chrome profile. Click the bookieMonster toolbar icon to watch the initial backup.

## How it works

bookieMonster calls the same internal GraphQL endpoints that x.com uses for its bookmarks pages (`Bookmarks`, `BookmarkFoldersSlice` and `BookmarkFolderTimeline`), using your existing browser session. X rotates these query IDs. The extension finds the current ones in the x.com web app's own JavaScript chunks and finds them again when X rejects a stale one.

It differs from [xarchive](https://github.com/sytelus/xarchive), which it was derived from, in two ways:

- **End of list.** X ends a timeline with empty pages or a repeated cursor. bookieMonster treats that as the end of the list. xarchive treats it as an error and marks the export partial.
- **Folder contents.** The folder query ID lives in a chunk that loads only when needed, and xarchive's discovery never reaches it. bookieMonster finds it through the chunk map in the signed-in page.

Adding, removing and refiling bookmarks is detected by observing the bookmark requests x.com sends from your own tabs. Nothing is changed on your account, and no data leaves your computer. See [PRIVACY.md](PRIVACY.md).

## Permissions

| Permission | Why |
|---|---|
| Host access to `x.com` and `abs.twimg.com` | Read your bookmarks and folders with your session; read the x.com web app's scripts to find current query IDs. |
| `cookies` | Read the x.com CSRF token (`ct0`) that X requires on API requests. |
| `webRequest` | Notice bookmark additions, removals and folder changes made on x.com, so the archive updates immediately. |
| `declarativeNetRequestWithHostAccess` | Give the extension's own x.com API requests the `Origin` and `Referer` headers that x.com expects. |
| `alarms` | Schedule retries and periodic checks. |
| `downloads`, `offscreen` | Save the archive files to your Downloads folder. |
| `unlimitedStorage` | Store a large archive locally in IndexedDB. |

## Limitations

- X's internal API is undocumented and can change without notice. bookieMonster detects the common kinds of change, but an unusual one can stop syncing until the extension is updated.
- Automated use of the internal API is not sanctioned by X. bookieMonster paces its requests the way a person scrolling would and only reads data, but some risk to the account remains.
- Bookmark changes made on other devices are picked up by the timed check, not immediately. A removal made elsewhere is not detected.
- The archive belongs to one X account. If you sign in to a different account, syncing stops rather than mixing two archives.

## Development

```
npm test              # offline engine tests
npm run test:live     # engine against a real session; needs X_AUTH_TOKEN and X_CT0
npm run icons         # regenerate icons
npm run package       # build dist/bookieMonster-<version>.zip
```

`extension/lib/engine.js` holds all sync logic and has no Chrome dependencies. `extension/background.js` connects it to Chrome.

## License

MIT. The response parser is adapted from xarchive (MIT). See [LICENSE](LICENSE).
