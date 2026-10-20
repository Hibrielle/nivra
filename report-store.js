import { t } from './i18n.js';
let opening;
function database() {
  if (!opening)
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('nivra-reports', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('reports', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return opening;
}
async function transaction(mode, work) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('reports', mode);
    const result = work(tx.objectStore('reports'));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error(t('报告保存已中断')));
  });
}
export const readReports = () => transaction('readonly', (store) => store.getAll());
export const saveReports = (reports) =>
  transaction('readwrite', (store) => {
    for (const report of reports) store.put(report);
  });
export const removeReports = (ids) =>
  transaction('readwrite', (store) => {
    for (const id of ids) store.delete(id);
  });
