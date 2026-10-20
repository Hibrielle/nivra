import { t, getLocale } from './i18n.js';
export class RuleWorkerPool {
  constructor(size = 2) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.nextId = 0;
  }
  run(operation, payload, { timeout = 600, deadline = 5000 } = {}) {
    if (this.queue.length > 1000) return Promise.reject(new Error(t('规则计算队列已满')));
    return new Promise((resolve, reject) => {
      const job = {
        id: ++this.nextId,
        operation,
        locale: getLocale(),
        payload,
        resolve,
        reject,
        timeout,
      };
      job.deadline = setTimeout(
        () => this.cancel(job, t('规则计算等待超时，已保留浏览器默认下载位置')),
        deadline,
      );
      this.queue.push(job);
      this.drain();
    });
  }
  spawn() {
    const worker = new Worker(new URL('./evaluation-worker.js', import.meta.url), {
      type: 'module',
    });
    const slot = { worker, ready: false, job: null };
    this.workers.push(slot);
    worker.onmessage = ({ data }) => {
      if (data.ready) {
        slot.ready = true;
        this.drain();
        return;
      }
      if (slot.job?.id !== data.id) return;
      const job = slot.job;
      job.done = true;
      slot.job = null;
      clearTimeout(job.timer);
      clearTimeout(job.deadline);
      data.error ? job.reject(new Error(data.error)) : job.resolve(data.result);
      this.drain();
    };
    worker.onerror = () => {
      if (slot.job) this.cancel(slot.job, t('规则工作线程异常'));
      else {
        worker.terminate();
        this.workers = this.workers.filter((s) => s !== slot);
        const waiting = this.queue.splice(0);
        for (const job of waiting) {
          job.done = true;
          clearTimeout(job.deadline);
          job.reject(new Error(t('规则工作线程无法启动')));
        }
      }
    };
    return slot;
  }
  cancel(job, message) {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.timer);
    clearTimeout(job.deadline);
    this.queue = this.queue.filter((j) => j !== job);
    const slot = this.workers.find((s) => s.job === job);
    if (slot) {
      slot.worker.terminate();
      this.workers = this.workers.filter((s) => s !== slot);
    }
    job.reject(new Error(message));
    this.drain();
  }
  drain() {
    while (this.workers.length < this.size && this.queue.length) this.spawn();
    for (const slot of this.workers) {
      if (!this.queue.length) break;
      if (!slot.ready || slot.job) continue;
      const job = this.queue.shift();
      slot.job = job;
      job.timer = setTimeout(
        () => this.cancel(job, t('规则计算超过 {0} 毫秒，可能存在高开销正则', job.timeout)),
        job.timeout,
      );
      slot.worker.postMessage({
        id: job.id,
        operation: job.operation,
        locale: job.locale,
        payload: job.payload,
      });
    }
  }
}
