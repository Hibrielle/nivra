import { setLocale } from '../i18n.js';
import { parentPort } from 'node:worker_threads';
import { evaluateOperation } from '../evaluation-core.js';
parentPort.on('message', ({ operation, payload, locale }) => {
  setLocale(locale);
  try {
    parentPort.postMessage({ result: evaluateOperation(operation, payload) });
  } catch (error) {
    parentPort.postMessage({ error: error.message });
  }
});
parentPort.postMessage({ ready: true });
