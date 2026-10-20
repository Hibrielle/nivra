import { initI18n, translateDocument } from './i18n.js';

await initI18n();
translateDocument();
const entry = {
  '/manager.html': './manager.js',
  '/popup.html': './popup.js',
  '/report.html': './report-ui.js',
}[location.pathname];
if (entry) await import(entry);
