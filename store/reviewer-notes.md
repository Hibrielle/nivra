# Reviewer test instructions

## Dashboard field (500-character limit)

No login or credentials required. Open the toolbar popup > Start setup > Save and download to download bundled nivra-test.txt. Check tasks in the manager; try Organization rules, Find resources on an HTTP(S) page, and Download report. Settings changes language/theme. External clients are optional and use the reviewer's own service. Full steps: https://github.com/Hibrielle/nivra/blob/main/store/reviewer-notes.md

## Full instructions

Core functionality needs no account, login, paid service, or credentials. The UI supports English and Simplified Chinese.

1. Open Nivra's toolbar popup, choose **Start setup**, select type/month/day organization, and use **Save and download**. This downloads the bundled `nivra-test.txt` and shows the resulting task. The location is a relative path under Chrome's own downloads folder.
2. Download a file from an ordinary webpage. Check its progress in the popup and full manager. Use the task's menu for copy, report, retry, or reveal. Pause/resume availability depends on Chrome and the server. File deletion has a separate confirmation; “Remove task only” keeps the file.
3. Open **Organization rules**. Edit a default or choose a template; preview a matching sample before saving. **Import / AI setup** accepts validated JSON and previews changes before applying them. It does not fetch or execute remote scripts.
4. Open **Find resources**, select an ordinary HTTP(S) page, and scan it. Optional continuous capture applies only to selected tabs. Reports use request metadata to associate observed endpoint IPs and redirects with downloads; speed reports and records remain local.
5. Open **Settings** to choose English/Chinese/Follow browser, inspect the local privacy policy, manually upload or delete a rule backup, or configure an optional downloader. Switching language keeps existing file names and paths unchanged.

External downloader integration is optional and not needed to use or test the main download manager. If testing it, use your own qBittorrent Web UI, Transmission RPC, or aria2 JSON-RPC service. No developer-hosted service or reviewer login is required. Nivra tests the configured endpoint and submits the actual .torrent file only on user action. Use HTTPS for remote services; HTTP remains available for user-specified clients and local integrations, with an in-product explanation of its transport behavior. qBittorrent CSRF protection does not need to be disabled.

Notifications, native file opening, and local-file URL access are requested when used. Without file URL access, torrent handoff falls back to a user-selected file. There is no automatic file opening or bundled file previewer.

The Chrome package contains only the extension runtime, icons, examples, documentation, and licenses. MCP, automated tests, development dependencies, and marketing files are excluded. Runtime dependencies are bundled locally. Source: https://github.com/Hibrielle/nivra

Automated checks use real Chrome downloads and isolated local services. The native file-open API is intercepted in automation to avoid launching desktop applications; native OS permission prompts and cross-device Chrome Sync propagation are not claimed as automated coverage.
