# Store submission materials

Version: **1.0.0**, not yet published on the Chrome Web Store.

| Material                                   | Location                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| Extension ZIP                              | `../dist/nivra-1.0.0.zip`, produced by `npm run pack`        |
| SHA-256                                    | `../dist/SHA256SUMS.txt`                                     |
| English listing                            | [listing-en.md](listing-en.md)                               |
| Simplified Chinese listing                 | [listing-zh-CN.md](listing-zh-CN.md)                         |
| Privacy fields and permission explanations | [privacy-practices.md](privacy-practices.md)                 |
| Reviewer instructions                      | [reviewer-notes.md](reviewer-notes.md)                       |
| Icon                                       | `assets/icon128.png`, 128 × 128 PNG with transparent padding |
| Promotional tile                           | `assets/promo-440x280.png`, 440 × 280 PNG                    |
| English screenshots                        | `assets/en/1-manager.png`, `2-setup.png`, `3-report.png`     |
| Chinese screenshots                        | `assets/zh-CN/1-manager.png`, `2-setup.png`, `3-report.png`  |
| Public website                             | https://hibrielle.github.io/nivra/                           |
| Public privacy policy                      | https://hibrielle.github.io/nivra/privacy.html               |
| Source and support                         | https://github.com/Hibrielle/nivra                           |

Screenshots are unmodified 1280 × 800 captures of the running extension with local sample downloads. The report chart comes from a real throttled local download. They contain no personal browser records, credentials, or user account UI. The promotional tile is rendered from `promo.html` using Nivra's own vector mark.

To regenerate: run `npm run test:i18n` against the built extension, then `node scripts/build-store-assets.mjs`. Set `CHROME_EXECUTABLE` if Playwright's default Chromium is not installed.

## Submission sequence

1. Verify the published privacy URL opens without signing in.
2. Upload the ZIP as a new item in the [developer dashboard](https://chrome.google.com/webstore/devconsole/).
3. Fill the English default listing, add the Chinese translation, upload the icon, promotional tile, and screenshots.
4. Fill the privacy fields and reviewer instructions, and confirm the actual data-use certifications and distribution choices.
5. Submit for review. Record the real item ID and resulting review state; do not describe a saved draft as published or approved.

The publisher account's paid registration and verified contact email were checked in the dashboard. Account identity, contact details, and trader declarations are maintained there. No account credentials are included here.

[Google's image requirements](https://developer.chrome.com/docs/webstore/images) · [Publishing steps](https://developer.chrome.com/docs/webstore/publish)
