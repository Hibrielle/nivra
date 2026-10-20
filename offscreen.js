import { setLocale } from './i18n.js';
import { RuleWorkerPool } from './worker-pool.js';
const pool = new RuleWorkerPool();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'rule-runtime') return;
  if (message.operation === 'ping') {
    respond({ ok: true, result: true });
    return;
  }
  setLocale(message.locale);
  pool.run(message.operation, message.payload).then(
    (result) => respond({ ok: true, result }),
    (error) => respond({ ok: false, error: error.message }),
  );
  return true;
});
