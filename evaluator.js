import { t, getLocale } from './i18n.js';
let creating;
export async function evaluateBackground(operation, payload) {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (!contexts.length) {
    if (!creating)
      creating = chrome.offscreen
        .createDocument({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: t('在独立线程中运行正则和条件表达式，超时可中断，避免阻塞下载。'),
        })
        .finally(() => {
          creating = null;
        });
    await creating;
  }
  // Document creation can finish before its module registers the message listener.
  const deadline = Date.now() + 2000;
  let ready = false;
  while (!ready) {
    try {
      ready =
        (await chrome.runtime.sendMessage({ target: 'rule-runtime', operation: 'ping' }))?.ok ===
        true;
    } catch {}
    if (ready) break;
    if (Date.now() > deadline) throw new Error(t('规则工作线程页面未就绪'));
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const response = await chrome.runtime.sendMessage({
    target: 'rule-runtime',
    locale: getLocale(),
    operation,
    payload,
  });
  if (!response?.ok) throw new Error(response?.error || t('规则工作线程未响应'));
  return response.result;
}
export async function evaluateUI(operation, payload) {
  const response = await chrome.runtime.sendMessage({ type: 'EVALUATE', operation, payload });
  if (!response?.ok) throw new Error(response?.error || t('规则计算失败'));
  return response.result;
}
