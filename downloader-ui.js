import { t } from './i18n.js';
import { h, request } from './ui.js';
import { DOWNLOADERS, MAX_TORRENT_BYTES, bytesToBase64, validateTorrent } from './downloader.js';
export function downloaderSettingsMarkup(config) {
  return `<section class="feature-panel downloader-settings" id="downloaderSettings"><h2>${t('外部下载器')}</h2><p>${t('绑定本机或 NAS 上的下载器，在种子任务的「更多操作」中发送。请先开启下载器的 Web UI/RPC。')}</p>
    <form id="downloaderForm" autocomplete="off"><div class="form-grid"><label class="field">${t('下载器类型')}<select name="clientType">${Object.entries(
      DOWNLOADERS,
    )
      .map(
        ([type, info]) =>
          `<option value="${type}" ${config?.type === type ? 'selected' : ''}>${info.name}</option>`,
      )
      .join(
        '',
      )}</select></label><label class="field">${t('服务地址')}<input name="endpoint" type="url" required maxlength="2048" value="${h(config?.url || '')}"></label></div>
    <div class="form-grid"><label class="field" id="downloaderUsername">${t('用户名')}<input name="username" maxlength="256" value="${h(config?.username || '')}" autocomplete="off"></label><label class="field"><span id="downloaderSecretLabel">${t('密码')}</span><input name="secret" type="password" maxlength="4096" autocomplete="new-password"><span id="downloaderSecretHint" class="field-hint"></span></label></div>
    <div class="row wrap"><button type="button" id="testDownloader" class="button">${t('测试连接')}</button><button type="submit" class="button primary">${t('保存绑定')}</button><button type="button" id="clearDownloader" class="text-button" ${config ? '' : 'hidden'}>${t('解除绑定')}</button></div><p id="downloaderStatus" role="status" aria-live="polite">${config ? t('已绑定 ') + h(config.name) : t('尚未绑定')}</p>
    <p class="field-hint">${t('文件保存位置使用下载器自身设置。账号和密钥仅保存在本机扩展存储中，不进入规则导出和云端备份。 建议使用 HTTPS；HTTP 会明文传输登录信息和种子数据。')}</p></form>
    <details><summary>${t('如何直接发送已下载的种子？')}</summary><p class="field-hint">${t('在扩展详情中开启「允许访问文件网址」，再授权读取本地文件，即可直接发送。未开启时，会提示你选择对应的种子文件。')}</p><div class="row wrap"><button id="downloaderFileDetails" class="button">${t('打开扩展详情')}</button><button id="downloaderFilePermission" class="button">${t('授权读取本地文件')}</button></div></details></section>`;
}
export function bindDownloaderSettings({ config, refresh, toast }) {
  const form = document.querySelector('#downloaderForm');
  const status = document.querySelector('#downloaderStatus');
  let saved = config;
  let busy = false;
  const sameEndpoint = () =>
    saved &&
    form.clientType.value === saved.type &&
    form.endpoint.value.trim().replace(/\/$/, '') === saved.url &&
    form.username.value.trim() === (saved.username || '');
  const update = () => {
    const type = form.clientType.value;
    form.endpoint.placeholder = DOWNLOADERS[type].placeholder;
    document.querySelector('#downloaderUsername').hidden = type === 'aria2';
    document.querySelector('#downloaderSecretLabel').textContent =
      type === 'aria2' ? t('RPC 密钥') : t('密码');
    const retained = sameEndpoint() && saved.hasSecret;
    form.secret.placeholder = retained
      ? t('已保存；留空保留')
      : type === 'aria2'
        ? t('未设密钥时可留空')
        : t('请输入密码');
    document.querySelector('#downloaderSecretHint').textContent = retained
      ? t('修改类型、地址或用户名后，请重新填写密钥。')
      : '';
  };
  const draft = () => ({
    type: form.clientType.value,
    url: form.endpoint.value,
    username: form.clientType.value === 'aria2' ? '' : form.username.value,
    ...(!form.secret.value && sameEndpoint() && saved.hasSecret
      ? {}
      : { secret: form.secret.value }),
  });
  async function run(operation) {
    if (busy) return;
    busy = true;
    status.classList.remove('form-error');
    for (const element of form.elements) element.disabled = true;
    try {
      await operation();
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('form-error');
    } finally {
      busy = false;
      for (const element of form.elements) element.disabled = false;
    }
  }
  form.oninput = () => {
    status.classList.remove('form-error');
    status.textContent = t('设置已修改，尚未保存');
    update();
  };
  form.clientType.onchange = () => {
    form.secret.value = '';
    if (form.clientType.value === 'aria2') form.username.value = '';
    update();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const downloader = draft();
    void run(async () => {
      const result = await request('SAVE_DOWNLOADER', { downloader });
      saved = result.downloader;
      form.endpoint.value = saved.url;
      form.secret.value = '';
      document.querySelector('#clearDownloader').hidden = false;
      status.textContent = t('已绑定 ') + saved.name + t(' · 可从种子任务发送');
      update();
      await refresh();
    });
  };
  document.querySelector('#testDownloader').onclick = () => {
    if (!form.reportValidity()) return;
    const downloader = draft();
    void run(async () => {
      status.textContent = t('正在测试连接…');
      const result = await request('TEST_DOWNLOADER', { downloader });
      status.textContent = t(
        '连接成功 · {0} {1} · {2}',
        result.name,
        result.version,
        sameEndpoint() && !form.secret.value ? t('当前绑定') : t('点击保存绑定后生效'),
      );
    });
  };
  document.querySelector('#clearDownloader').onclick = () => {
    if (!confirm(t('解除当前下载器绑定，并清除本机保存的账号和密钥？下载器中的任务会保留。')))
      return;
    void run(async () => {
      await request('CLEAR_DOWNLOADER');
      saved = null;
      form.endpoint.value = form.username.value = form.secret.value = '';
      document.querySelector('#clearDownloader').hidden = true;
      status.textContent = t('已解除绑定');
      update();
      await refresh();
    });
  };
  document.querySelector('#downloaderFileDetails').onclick = () =>
    chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
  document.querySelector('#downloaderFilePermission').onclick = async () => {
    try {
      const allowed = await chrome.permissions.request({ origins: ['file:///*'] });
      const enabled = await chrome.extension.isAllowedFileSchemeAccess();
      toast(
        allowed && enabled
          ? t('已允许直接读取本地种子')
          : t('请在扩展详情开启「允许访问文件网址」，也可以在发送时选择文件'),
      );
    } catch {
      toast(t('请在扩展详情开启文件访问，或在发送时选择文件'));
    }
  };
  update();
}
const pending = new Set();
export async function sendTorrentFromUI(id, { downloader, configure, toast }) {
  if (!downloader) {
    await configure();
    return;
  }
  if (pending.has(id)) {
    toast(t('这个种子正在发送，请等待结果'));
    return;
  }
  const success = (result) =>
    toast(
      result.duplicate
        ? t('此种子已提交到 {0}，请到下载器查看', result.name)
        : t('已提交到 {0}，下载进度请到下载器查看', result.name),
    );
  pending.add(id);
  try {
    toast(t('正在发送到 ') + downloader.name + '…');
    const result = await request('SEND_TORRENT', { id, bindingId: downloader.bindingId });
    if (result.needsBinding) {
      await configure();
      return;
    }
    if (!result.needsFile) {
      success(result);
      return;
    }
    if (document.querySelector('#torrentFileDialog')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'torrentFileDialog';
    dialog.className = 'modal torrent-file-dialog';
    dialog.setAttribute('aria-labelledby', 'torrentFileTitle');
    dialog.innerHTML = `<form><h2 id="torrentFileTitle">${t('选择要发送的种子')}</h2><p>${t('发送到 {0}', h(downloader.name))}</p><p class="torrent-file-name">${h(result.filename)}</p><p class="field-hint">${t('浏览器未允许直接读取这个文件，请选择上面的种子。最多 4 MB。')}</p><label class="field">${t('种子文件')}<input id="torrentFileInput" type="file" accept=".torrent,application/x-bittorrent" required></label><p id="torrentFileError" class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" class="button" id="cancelTorrentFile">${t('取消')}</button><button type="submit" class="button primary" id="submitTorrentFile">${t('发送种子')}</button></div></form>`;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('#cancelTorrentFile').onclick = () => dialog.close();
    dialog.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      const file = dialog.querySelector('#torrentFileInput').files[0];
      if (!file || pending.has(id)) return;
      pending.add(id);
      const button = dialog.querySelector('#submitTorrentFile');
      button.disabled = true;
      button.textContent = t('正在发送…');
      dialog.querySelector('#torrentFileError').textContent = '';
      try {
        if (file.name !== result.filename) throw new Error(t('请选择与上方文件名一致的种子'));
        if (file.size > MAX_TORRENT_BYTES) throw new Error(t('种子文件超过 4 MB'));
        const bytes = validateTorrent(new Uint8Array(await file.arrayBuffer()));
        const sent = await request('SEND_TORRENT', {
          id,
          bindingId: downloader.bindingId,
          filename: file.name,
          data: bytesToBase64(bytes),
        });
        if (sent.needsBinding) throw new Error(t('下载器绑定已被解除，请重新配置'));
        dialog.close();
        success(sent);
      } catch (error) {
        dialog.querySelector('#torrentFileError').textContent = error.message;
      } finally {
        pending.delete(id);
        button.disabled = false;
        button.textContent = t('发送种子');
      }
    };
    dialog.showModal();
  } finally {
    pending.delete(id);
  }
}
