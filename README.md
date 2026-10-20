# Nivra

A Chrome download manager with automatic file organization, resource discovery, and local download reports.

[简体中文](README.zh-CN.md) · [Privacy policy](https://hibrielle.github.io/nivra/privacy.html) · [Changelog](CHANGELOG.md) · [Validation notes](PARITY.md)

Version **1.0.0** was submitted to the Chrome Web Store on October 20, 2026 and is awaiting review. It will be published automatically after approval. Requires **Chrome 127+**. No account is required for core features.

## What it does

| Feature                        | What you get                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Download manager               | A fixed-size popup and a full manager with pause, resume, cancel, retry, search, multiple selection, notes, and task menus                |
| Automatic organization         | 15 default categories covering 343 extensions; combine file types with monthly or daily folders and choose the folder order               |
| Custom rules                   | Extension, domain, keyword, MIME, regex, and supported Chrono conditions; path previews, 21 templates, import/export, and undo            |
| Resource discovery and batches | Scan selected pages, capture selected tabs' network resources, expand URL ranges, and use concurrent or scheduled queues                  |
| Reports and integrations       | Sampled speed charts, pauses, observed connection IPs, optional torrent handoff to qBittorrent/Transmission/aria2, and a local MCP helper |

English and Simplified Chinese are included. Nivra follows Chrome's language by default: Chinese browser languages use Simplified Chinese; other languages use English. Choose **Settings → Interface language** to override it. Changing the UI language does not rename existing rules, file names, notes, or download folders. Light and dark themes are available.

## Install from source

1. Download this repository as a ZIP and extract it, or clone it with `git clone https://github.com/Hibrielle/nivra.git`.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the repository folder containing `manifest.json`. Pin Nivra's icon and open **Start setup**.

Bundled runtime dependencies are included in `vendor/`; running the extension does not require Node.js. After updating the files, select **Reload** on Chrome's extensions page.

## Organization and file actions

Nivra only organizes **new downloads**. It does not move existing files. Paths are relative to Chrome's download root; change that root in Chrome's download settings. An optional Nivra subfolder is added before rule and batch paths.

Examples, relative to your archive subfolder:

| Choice           | Example path                      |
| ---------------- | --------------------------------- |
| File type only   | `Documents/report.pdf`            |
| Month only       | `2026-10/report.pdf`              |
| Day only         | `2026-10-20/report.pdf`           |
| Type, then month | `Documents/2026-10/report.pdf`    |
| Day, then type   | `2026-10-20/Documents/report.pdf` |

Turning off both type and time grouping pauses automatic organization. Unmatched downloads also use Chrome's default location. Custom rule folders are preserved when adjusting the default layout. Chrome's Save As dialog and other download extensions can change the final location.

Use a task's **⋯** menu to copy its link, open it, show it in its folder, retry it, or view its report. Double-click or press Enter to open a completed file with Chrome's default opening behavior. The first use may request permission. Completion notifications open task details; files are never opened automatically.

**Remove task only** moves a record to Nivra's restorable trash. **Clear browser record** removes Chrome's download history entry. **Delete local file** requires confirmation and deletes the actual disk file; Nivra cannot undo this and does not promise it will enter the system trash.

## Reports and privacy

Reports sample progress about once per second while Chrome is running, even with the manager closed. They show observed average and peak speeds, pauses, interruptions, and connection endpoints observed through Chrome's network events. Missing intervals remain gaps. Very short downloads may not have enough data for a chart.

An observed IP may belong to a CDN or proxy, not the origin server. Nivra does not perform a later DNS lookup or guess an IP when request ownership is ambiguous.

Records and reports stay on your device. Finished reports are retained for 30 days, up to 200 reports, under an approximately 8 MiB data budget. Nivra has no product telemetry or developer-operated data collection server. Rule backups are sent to Chrome Sync only when you choose to upload them; they can be deleted in settings. See the [privacy policy](privacy.html) for the complete data handling and retention details.

## External downloaders

Connect **qBittorrent, Transmission, or aria2** in settings. One connection is supported. Enable its Web UI/RPC, enter the service address and credentials, test the connection, and save it.

Completed `.torrent` tasks gain a **Send to…** action. Nivra submits the real torrent file to your configured downloader. Select the file manually when local file access is not allowed. The remote client handles download progress, file selection, destination folders, and seeding.

Credentials stay in local extension storage and are excluded from rule exports, backups, reports, and MCP. They are not additionally encrypted by Nivra. Prefer HTTPS; HTTP transmits credentials and torrent data without encryption. qBittorrent's CSRF protection can stay enabled.

## AI and MCP

Use **Import / AI setup** to describe your rules, copy a prompt to your AI, then preview and import the returned JSON. Existing rules are retained and duplicate configurations are skipped. AI-generated rules are never silently applied.

The optional local stdio MCP helper is provided in this repository and is not included in the store package:

```sh
npm ci
npm run mcp:config
```

Add the resulting configuration to a client that supports stdio MCP. Tools: `nivra_guide`, `nivra_create_pack`, `nivra_validate`, and `nivra_simulate`. They process caller-provided rules without accessing personal browser data or writing directly into the extension. See [examples/android-invoice.json](examples/android-invoice.json) for an importable pack.

## Limits

- Download folders must stay inside Chrome's download root. Arbitrary disk access and moving existing files are not supported.
- Download resumption depends on Chrome and the server. Nivra does not provide multithreaded acceleration.
- HLS/DASH segment merging, DRM handling, and exporting page-memory Blob data are not supported.
- Torrent handoff does not include magnet entry, a BitTorrent engine, or remote progress synchronization.
- Scheduled tasks require Chrome to be running and may be delayed by about one minute. Cross-device rule sync timing is controlled by Chrome.

## Development

Node.js 22+ is required for development, packaging, and MCP.

```sh
npm ci
npm test
npm run pack
```

Packaging produces `dist/unpacked`, `dist/nivra-1.0.0.zip`, and `dist/SHA256SUMS.txt`. The extension ZIP excludes tests, MCP, development dependencies, and store marketing assets.

Browser tests use isolated profiles and local fixture servers. Install Playwright's Chromium or set `CHROME_EXECUTABLE` to Chrome for Testing:

```sh
npx playwright install chromium
EXTENSION_DIR=dist/unpacked npm run test:i18n
EXTENSION_DIR=dist/unpacked npm run test:usability
```

Other suites cover classification, task menus and states, resource discovery, queues, reports, and external downloaders; see `package.json` and [PARITY.md](PARITY.md). Audio/video fixtures in `test:advanced` require `ffmpeg`. Native OS permission dialogs and applications launched by “Open file” are not fully automated.

Runtime code uses native JavaScript ES modules and bundled dependencies, with no runtime CDN. `i18n-messages.js` contains Chinese source messages and English translations; `_locales/` contains Chrome's extension metadata. `npm run build:vendor` rebuilds runtime libraries, and `npm run build:icons` renders icons from `icons/brand.svg`.

## License

[MIT](LICENSE). Bundled third-party licenses are in [vendor/LICENSES.md](vendor/LICENSES.md).
