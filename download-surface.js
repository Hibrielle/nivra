// Chrome 127+ permits opening an extension popup from the download event.
// Reuse an existing panel and coalesce batches so each file does not open a window.
let opening = Promise.resolve();
let lastOpened = 0;
export function presentDownload(item, config) {
  if (item.incognito || !config.autoOpenPanel) return Promise.resolve();
  const task = opening.then(async () => {
    if (Date.now() - lastOpened < 1500) return;
    const popupUrl = chrome.runtime.getURL('popup.html');
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['POPUP'],
      documentUrls: [popupUrl],
    });
    if (existing.length) return;
    const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const managers = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      tabIds: active ? [active.id] : [],
    });
    if (
      managers.some((context) =>
        context.documentUrl?.startsWith(chrome.runtime.getURL('manager.html')),
      )
    ) {
      await chrome.storage.session.set({ downloadSurface: { mode: 'manager', at: Date.now() } });
      return;
    }
    try {
      const browserWindow = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      await chrome.action.openPopup({ windowId: browserWindow.id });
      lastOpened = Date.now();
      await chrome.storage.session.set({ downloadSurface: { mode: 'toolbar', at: lastOpened } });
    } catch (popupError) {
      try {
        const saved = (await chrome.storage.session.get('monitorWindow')).monitorWindow;
        if (saved) {
          const window = await chrome.windows.get(saved).catch(() => null);
          if (window) {
            lastOpened = Date.now();
            return;
          }
        }
        const window = await chrome.windows.create({
          url: popupUrl + '?monitor=1',
          type: 'popup',
          width: 462,
          height: 630,
          focused: false,
        });
        lastOpened = Date.now();
        await chrome.storage.session.set({
          monitorWindow: window.id,
          downloadSurface: { mode: 'window', at: lastOpened },
        });
      } catch (error) {
        await chrome.storage.session.set({
          downloadSurface: {
            mode: 'failed',
            at: Date.now(),
            error: error.message,
            popupError: popupError.message,
          },
        });
      }
    }
  });
  opening = task.catch(() => {});
  return task;
}
