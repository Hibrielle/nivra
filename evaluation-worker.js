import { setLocale } from './i18n.js';
import { evaluateOperation } from './evaluation-core.js';
self.onmessage = ({ data }) => {
  setLocale(data.locale);
  try {
    self.postMessage({ id: data.id, result: evaluateOperation(data.operation, data.payload) });
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message });
  }
};
self.postMessage({ ready: true });
