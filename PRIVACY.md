# bookieMonster privacy policy

Effective 11 October 2026.

bookieMonster is a Chrome extension that backs up the X (formerly Twitter) bookmarks of the person using it. This policy describes what data it handles and where that data goes.

## Data the extension handles

- **Bookmark content.** The posts you have bookmarked on X, with their text, author names and handles, links, media URLs, quoted posts, link previews and public engagement counts, plus the names of your bookmark folders and which bookmarks they contain.
- **Account identifiers.** Your X user ID and handle, used to label the archive and to avoid mixing archives from two accounts.
- **Session token.** The x.com `ct0` cookie, read at the moment of each request and sent only to x.com. It is never stored by the extension.
- **Bookmark actions.** When you add, remove or file a bookmark on x.com, the extension reads the post ID and folder ID from that request to update the archive.

## Where data goes

- All data stays on your computer, in the extension's local storage (IndexedDB) and in files saved to your Downloads folder.
- The extension sends requests only to x.com, to read your bookmarks with your own session, and to abs.twimg.com, to read x.com's public JavaScript files.
- No data is sent to the developer or to any other party. The extension contains no analytics, advertising or tracking code.
- Data is not sold or transferred, and is not used for any purpose other than the archive described above.

## Your control

- Removing the extension deletes its local storage. Files saved to Downloads remain until you delete them.
- You can turn off automatic saving on the extension's dashboard.

## Contact

Open an issue at https://github.com/kvkalidindi/bookieMonster/issues.
