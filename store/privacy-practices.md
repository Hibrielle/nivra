# Chrome Web Store privacy fields

These fields describe the shipped extension. Local processing still needs disclosure; do not select “does not collect or use user data.”

## Single purpose

Manage and organize files downloaded through Chrome. Nivra provides download controls, automatic save-path rules, selected-page resource discovery, and local download diagnostics within this single download-management workflow. Optional external clients receive torrent downloads chosen by the user.

## Permission justifications

| Permission                            | Text for the dashboard                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `downloads`                           | Observe Chrome download tasks, determine relative save paths, report progress, and perform user-requested pause, resume, cancel, retry, reveal, history removal, and confirmed file deletion.                                                                                                                                                                   |
| `storage`                             | Store rules, settings, download metadata, and the queue locally; hold resource discovery results in session storage; use Chrome Sync only for manually requested rule backups.                                                                                                                                                                                  |
| `offscreen`                           | Host local Web Workers for bounded regular-expression and condition evaluation when downloads are handled by the service worker. Workers can be terminated on timeout.                                                                                                                                                                                          |
| `scripting`                           | Run the extension's bundled resource scanner in pages explicitly selected by the user. It reads links, image/media sources, CSS image URLs, and resource timing metadata.                                                                                                                                                                                       |
| `contextMenus`                        | Add user-triggered “Download with Nivra” and “Find downloadable resources” actions to Chrome's context menu.                                                                                                                                                                                                                                                    |
| `alarms`                              | Dispatch scheduled queue tasks and perform configured local record/report retention while Chrome is running.                                                                                                                                                                                                                                                    |
| `webRequest`                          | Observe request metadata to associate download reports with connection IPs and redirects, and capture resource metadata from user-selected tabs. No request/response bodies are retained. The short-lived association cache is bounded and stays in memory.                                                                                                     |
| `downloads.ui`                        | Let users choose Nivra's download popup instead of Chrome's default download interface. This behavior can be disabled in Nivra settings.                                                                                                                                                                                                                        |
| `declarativeNetRequestWithHostAccess` | Temporarily adapt Origin/Referer headers only on this extension's requests to the qBittorrent API address configured by the user. The login request also omits its outgoing cookie so qBittorrent validates the supplied password. Rules do not affect ordinary website requests and are removed after the operation.                                           |
| `notifications` (optional)            | Notify users of completed downloads if they enable notifications and grant permission. Clicking a notification opens task details.                                                                                                                                                                                                                              |
| `downloads.open` (optional)           | Open a completed file only after the user chooses an open action, double-clicks a task, or presses Enter. Requested when used; files are not opened automatically.                                                                                                                                                                                              |
| HTTP and HTTPS hosts                  | Download endpoints and CDN redirects can be on arbitrary sites. Access is used for connection diagnostics, resource discovery on selected pages, resource loading, and requests to the downloader explicitly configured by the user. Reading matching tab metadata is covered by these host permissions; no separate tabs or activeTab permission is requested. |
| `file:///*` (optional)                | Read only the downloaded .torrent file the user chooses to send to their configured downloader. The feature requires Chrome's separate file-URL toggle and an explicit grant; otherwise the user selects the file manually. No disk-wide scanning or file viewer is implemented.                                                                                |

## Remote code

Select **No**. All executable logic and runtime libraries are bundled in the extension. Imported rule JSON is validated as matching and naming data; the local restricted expression interpreter does not execute arbitrary JavaScript. Site images and downloaded files are data, not remotely executed extension code. The optional MCP helper is outside the store package.

## Data usage categories

| Category                                                          | Declare                 | Scope                                                                                                                                                                              |
| ----------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personally identifiable information                               | Yes                     | The optional external downloader username can be personal information. It is stored locally and sent only to the configured service.                                               |
| Authentication information                                        | Yes                     | User-provided downloader passwords/RPC secrets. Local storage; sent only when testing or using the configured downloader.                                                          |
| Web history                                                       | Yes                     | Download source URLs, selected-page URLs, and brief request metadata used for download diagnostics. No developer analytics service receives this data.                             |
| Website content                                                   | Yes                     | Resource links, page titles, link text, file metadata, downloaded torrent contents chosen for handoff, and resource thumbnails.                                                    |
| User activity                                                     | Yes                     | Network metadata is briefly observed for download diagnostics. No keystroke, click, scroll, or mouse-position telemetry is collected.                                              |
| Health, financial/payment, personal communications, user location | No dedicated collection | Nivra does not implement these collection functions. Remote connection endpoint IPs are not used to locate the user. User-selected files may themselves contain arbitrary content. |

The three Limited Use certifications must reflect the developer's actual commitments: no sale or transfer outside the permitted user-facing purposes, no unrelated use/transfer, and no use for creditworthiness or lending.

Privacy URL: https://hibrielle.github.io/nivra/privacy.html

## Sources checked

- [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including disclosure for local processing and user-specified client/server connections
- [Extension contexts](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-getContexts)
