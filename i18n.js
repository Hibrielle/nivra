import { messages } from './i18n-messages.js';

const browserLanguage = () =>
  globalThis.chrome?.i18n?.getUILanguage() || globalThis.navigator?.language || 'en';
let preference = globalThis.localStorage?.getItem('uiLanguage') || 'auto';
let listening = false;

export function resolveLocale(value, browser = browserLanguage()) {
  if (value === 'auto') value = browser;
  return /^zh(?:-|_|$)/i.test(value || '') ? 'zh-CN' : 'en';
}
export const getLocale = () => resolveLocale(preference);
export const getLanguagePreference = () => preference;
export function setLocale(value) {
  preference = ['auto', 'en', 'zh-CN'].includes(value) ? value : 'auto';
}
export function translate(locale, message, ...values) {
  const key = message.trim();
  const translated = resolveLocale(locale) === 'zh-CN' ? key : messages[key] || key;
  const text =
    message.slice(0, message.indexOf(key)) +
    translated +
    message.slice(message.indexOf(key) + key.length);
  return text.replace(/\{(\d+)\}/g, (match, index) =>
    index < values.length ? String(values[index]) : match,
  );
}
export const t = (message, ...values) => translate(getLocale(), message, ...values);

export async function initI18n() {
  if (globalThis.chrome?.storage) {
    const saved = await chrome.storage.local.get({ uiLanguage: 'auto' });
    setLocale(saved.uiLanguage);
    if (!listening) {
      listening = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.uiLanguage) return;
        setLocale(changes.uiLanguage.newValue);
        if (globalThis.document) {
          localStorage.setItem('uiLanguage', preference);
          location.reload();
        }
      });
    }
  }
  if (globalThis.document) {
    localStorage.setItem('uiLanguage', preference);
    document.documentElement.lang = getLocale();
  }
}
export async function setLanguagePreference(value) {
  if (!['auto', 'en', 'zh-CN'].includes(value)) return;
  await chrome.storage.local.set({ uiLanguage: value });
}

// Only the initial static HTML is translated here, before user data is rendered.
export function translateDocument() {
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('script,style')) continue;
    if (Object.hasOwn(messages, node.textContent.trim())) node.textContent = t(node.textContent);
  }
  for (const element of document.querySelectorAll('[title],[aria-label],[placeholder],[alt]')) {
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
      const value = element.getAttribute(attribute);
      if (value && Object.hasOwn(messages, value.trim())) element.setAttribute(attribute, t(value));
    }
  }
}
