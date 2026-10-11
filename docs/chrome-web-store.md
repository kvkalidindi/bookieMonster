# Publishing bookieMonster on the Chrome Web Store

This guide covers publishing bookieMonster for the first time, then updating it. The text to paste into each form is included below.

## Before you start

| Item | Where it comes from |
|---|---|
| Extension package | `bookieMonster-<version>.zip`, attached to the GitHub release or built with `npm run package` |
| Store icon, 128×128 | `extension/icons/icon128.png` |
| Screenshot, 1280×800 | `docs/store/screenshot-1280x800.png` |
| Small promo tile, 440×280 | `docs/store/promo-440x280.png` |
| Privacy policy URL | `https://github.com/kvkalidindi/bookieMonster/blob/main/PRIVACY.md` |
| Google account | Two-step verification must be turned on |

## 1. Register as a Chrome Web Store developer (one time)

1. Sign in to the Google account that will own the listing. Use a personal account, not a managed work account, unless your organisation has approved publishing.
2. Open the Developer Dashboard at <https://chrome.google.com/webstore/devconsole>.
3. Accept the developer agreement and pay the one-time US$5 registration fee.
4. Under **Account**, set the publisher display name and the contact email address, then verify the email address. You can't publish until it is verified.

## 2. Upload the package

1. In the Developer Dashboard, click **New item**.
2. Upload `bookieMonster-1.0.0.zip`. The dashboard reads the name, version, icons and permissions from `manifest.json`.

## 3. Complete the Store listing tab

- **Description:**

  > bookieMonster keeps a complete, private backup of your X (formerly Twitter) bookmarks, including bookmark folders, and keeps it up to date automatically.
  >
  > • Complete backup: reads every bookmark and every folder from your signed-in x.com session, and resumes automatically after interruptions until the backup is complete.
  > • Always current: picks up new bookmarks, removals and folder changes within seconds when you make them on x.com, with a periodic check for changes made on other devices.
  > • Folder aware: records every folder each bookmark belongs to.
  > • LLM-ready: saves a full JSON archive, a JSONL file with one compact record per bookmark, and Markdown files sized for large-language-model context windows to Downloads/bookieMonster/.
  > • Private: all data stays on your computer. No accounts, servers, analytics or tracking.
  >
  > bookieMonster is an independent open-source project and is not affiliated with or endorsed by X Corp. Source code: https://github.com/kvkalidindi/bookieMonster

- **Category:** Productivity → Tools.
- **Language:** English.
- **Graphic assets:** upload the 128×128 icon, at least one 1280×800 screenshot, and the 440×280 small promo tile.
- **Official URL / Homepage URL:** `https://github.com/kvkalidindi/bookieMonster`
- **Support URL:** `https://github.com/kvkalidindi/bookieMonster/issues`

## 4. Complete the Privacy practices tab

**Single purpose:**

> Back up the user's own X bookmarks and bookmark folders to local files and keep that backup current.

**Permission justifications** (one box per permission):

| Permission | Justification |
|---|---|
| `alarms` | Schedules automatic retries of an interrupted backup and the periodic check for new bookmarks. |
| `cookies` | Reads the x.com CSRF token (ct0) that x.com requires on requests for the user's own bookmarks. The value is used only for those requests and is never stored or transmitted elsewhere. |
| `declarativeNetRequestWithHostAccess` | Sets the Origin and Referer headers that x.com expects on the extension's own requests to x.com/i/api. Applies only to requests made by the extension. |
| `downloads` | Saves the backup files (JSON, JSONL, Markdown) to the user's Downloads folder. |
| `offscreen` | Creates blob URLs for the backup files, which the service worker cannot do itself, so that they can be saved with chrome.downloads. |
| `unlimitedStorage` | Stores large bookmark archives, thousands of posts with metadata, locally in IndexedDB. |
| `webRequest` | Observes the user's own bookmark actions on x.com (add, remove, file into or out of a folder) so the backup updates immediately. Requests are only observed, never blocked or modified. |
| Host permissions (`https://x.com/*`, `https://abs.twimg.com/*`) | x.com: reads the user's bookmarks and folders with their signed-in session. abs.twimg.com: reads x.com's public JavaScript files to find the current API query identifiers. |

**Remote code:** answer **No, I am not using remote code**. The extension reads x.com's JavaScript files as text, to find query identifiers, and never executes them.

**Data usage.** Tick the categories the extension handles:

- **Website content.** The bookmarked posts: text, links and media URLs.
- **Personally identifiable information.** The X user ID and handle used to label the archive.
- **Authentication information.** The x.com CSRF token, which is read per request and never stored.

Then tick all three certifications:

1. I do not sell or transfer user data to third parties, outside of the approved use cases.
2. I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
3. I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** `https://github.com/kvkalidindi/bookieMonster/blob/main/PRIVACY.md`

## 5. Choose distribution

- **Visibility.** Choose **Public** to appear in search, **Unlisted** for anyone with the link, or **Private** for named testers only. Unlisted is a sensible first step.
- **Regions:** All regions, unless you want to restrict them.
- **Payment:** Free.

## 6. Submit for review

1. Click **Submit for review**. You may choose to publish automatically once the item is approved, or to publish by hand later.
2. Review usually takes a few days. Extensions with broad host access and `webRequest` often get in-depth review, which can take longer. The dashboard shows the status, and Google emails the contact address with the result.
3. If the item is rejected, the email names the policy involved. Fix the issue, increase `version` in `manifest.json`, rebuild the zip and resubmit.

## Updating a published version

1. Increase `version` in `extension/manifest.json` and in `package.json`.
2. Run `npm test`, then `npm run package`.
3. Commit, tag (`git tag v1.0.1`), push, and create a GitHub release with the new zip.
4. In the Developer Dashboard, open the item, choose **Package → Upload new package**, upload the zip, and submit for review. Installed copies update automatically after approval.

## Review risks

- **Third-party platform terms.** The extension uses x.com's internal web API with the user's own session. Many bookmark exporters on the store work the same way, but Google can still act on a complaint from X. The listing states that the project is independent and only reads the user's own data.
- **Trademarks.** Don't use the X or Twitter logo in the icon, screenshots or promo images. Mentioning "X (formerly Twitter)" in the description to explain compatibility is acceptable. The name bookieMonster plays on a well-known character name. Avoid any imagery resembling that character.
- **Permissions.** Requesting a permission the extension doesn't use is a common reason for rejection. Each permission above is used. Keep the justifications in step with the code if the code changes.
