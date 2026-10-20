import { getLocale } from '../i18n.js';
import { Worker } from 'node:worker_threads';
export function evaluateNode(operation, payload, timeout = 600) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./evaluation-worker.mjs', import.meta.url));
    let timer = setTimeout(() => finish(new Error('规则工作线程启动超时')), 5000),
      done = false;
    function finish(error, result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      error ? reject(error) : resolve(result);
    }
    worker.on('message', (message) => {
      if (message.ready) {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error(`规则计算超过 ${timeout} 毫秒`)), timeout);
        worker.postMessage({ operation, payload, locale: getLocale() });
      } else finish(message.error ? new Error(message.error) : null, message.result);
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => {
      if (!done) finish(new Error(`规则工作线程退出 (${code})`));
    });
  });
}
