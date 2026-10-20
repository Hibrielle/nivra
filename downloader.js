import { t } from './i18n.js';
// Protocol adapters are shared by the extension and the real-client tests.
export const DOWNLOADERS = {
  qbittorrent: { name: 'qBittorrent', placeholder: 'http://127.0.0.1:8080' },
  transmission: { name: 'Transmission', placeholder: 'http://127.0.0.1:9091' },
  aria2: { name: 'aria2', placeholder: 'http://127.0.0.1:6800/jsonrpc' },
};
export const MAX_TORRENT_BYTES = 4 * 1024 * 1024;
export function isTorrent(item) {
  return (
    /\.torrent$/i.test(item.filename || item.originalName || '') ||
    item.mime?.split(';')[0].trim().toLowerCase() === 'application/x-bittorrent'
  );
}
export function normalizeDownloader(value) {
  if (!value || !Object.hasOwn(DOWNLOADERS, value.type)) throw new Error(t('请选择下载器类型'));
  let url;
  try {
    url = new URL(String(value.url || '').trim());
  } catch {
    throw new Error(t('请输入完整服务地址，例如 http://127.0.0.1:8080'));
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href.length > 2048
  )
    throw new Error(
      t('服务地址只支持 HTTP/HTTPS，请将账号和密钥填在独立字段中，地址不要带查询参数'),
    );
  url.pathname = url.pathname.replace(/\/+$/, '');
  const username = String(value.username || '').trim();
  const secret = String(value.secret || '');
  if (username.length > 256 || /[\r\n:]/.test(username) || secret.length > 4096)
    throw new Error(t('账号或密钥格式无效'));
  return {
    type: value.type,
    url: url.href.replace(/\/$/, ''),
    username: value.type === 'aria2' ? '' : username,
    secret,
  };
}
export function bytesToBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 16384)
    text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
}

// Validate bounded bencode before uploading. No metadata viewer or BT engine is involved.
export function validateTorrent(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_TORRENT_BYTES)
    throw new Error(t('种子文件须介于 1 字节和 4 MB 之间'));
  let offset = 0,
    entries = 0;
  const decoder = new TextDecoder();
  const fail = () => {
    throw new Error(t('文件不是有效的 .torrent 种子'));
  };
  const string = () => {
    const begin = offset;
    while (offset < bytes.length && bytes[offset] >= 48 && bytes[offset] <= 57) offset++;
    if (begin === offset || offset - begin > 8 || bytes[offset++] !== 58) fail();
    const size = Number(decoder.decode(bytes.subarray(begin, offset - 1)));
    if (offset + size > bytes.length) fail();
    const result = bytes.subarray(offset, offset + size);
    offset += size;
    return result;
  };
  function read(depth = 0) {
    if (++entries > 100000 || depth > 48 || offset >= bytes.length) fail();
    const token = bytes[offset];
    if (token >= 48 && token <= 57) {
      string();
      return 'string';
    }
    offset++;
    if (token === 105) {
      const begin = offset;
      while (offset < bytes.length && bytes[offset] !== 101 && offset - begin < 24) offset++;
      if (
        bytes[offset] !== 101 ||
        !/^-?(0|[1-9][0-9]*)$/.test(decoder.decode(bytes.subarray(begin, offset)))
      )
        fail();
      offset++;
      return 'integer';
    }
    if (token !== 108 && token !== 100) fail();
    let info = false;
    while (offset < bytes.length && bytes[offset] !== 101) {
      const key = token === 100 ? string() : null;
      const type = read(depth + 1);
      if (depth === 0 && key && decoder.decode(key) === 'info') info = type === 'dict';
    }
    if (bytes[offset++] !== 101 || (depth === 0 && (token !== 100 || !info))) fail();
    return token === 100 ? 'dict' : 'list';
  }
  if (bytes[0] !== 100) fail();
  read();
  if (offset !== bytes.length) fail();
  return bytes;
}
export function decodeTorrent(value) {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(MAX_TORRENT_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error(t('种子数据无效或超过 4 MB'));
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(t('种子数据编码无效'));
  }
  return validateTorrent(bytes);
}
async function http(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError')
      throw new Error(t('下载器响应超时；发送过种子时请先在下载器中确认，避免重复提交'));
    throw new Error(
      t('无法连接下载器，请检查地址、Web UI/RPC 开关和网络；服务地址需直接到达接口，不能重定向'),
    );
  }
  if (response.status === 401 || response.status === 403)
    throw new Error(t('下载器拒绝访问，请检查账号、密钥及 Web UI/RPC 访问设置'));
  return response;
}
async function json(response) {
  if (!response.ok) throw new Error(t('下载器接口返回 HTTP {0}', response.status));
  try {
    return await response.json();
  } catch {
    throw new Error(t('地址返回的不是下载器 API，请检查服务地址'));
  }
}
async function qbLogin(config) {
  const response = await http(config.url + '/api/v2/auth/login', {
    method: 'POST',
    credentials: 'include',
    body: new URLSearchParams({ username: config.username, password: config.secret }),
  });
  if (!response.ok || (await response.text()).trim() !== 'Ok.')
    throw new Error(t('qBittorrent 登录失败，请检查用户名和密码'));
}
function transmissionURL(config) {
  if (/\/transmission\/web$/.test(config.url)) return config.url.replace(/\/web$/, '/rpc');
  if (/\/rpc$/.test(config.url)) return config.url;
  return config.url + '/transmission/rpc';
}
async function transmissionSession(config) {
  let session = '';
  let modern = false;
  const headers = { 'Content-Type': 'application/json' };
  if (config.username || config.secret)
    headers.Authorization =
      'Basic ' + bytesToBase64(new TextEncoder().encode(config.username + ':' + config.secret));
  async function rpc(method, args = {}) {
    const message = modern
      ? {
          jsonrpc: '2.0',
          id: 1,
          method: method.replaceAll('-', '_'),
          params: Object.fromEntries(
            Object.entries(args).map(([key, value]) => [key.replaceAll('-', '_'), value]),
          ),
        }
      : { method, arguments: args };
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await http(transmissionURL(config), {
        method: 'POST',
        credentials: 'omit',
        headers: { ...headers, ...(session ? { 'X-Transmission-Session-Id': session } : {}) },
        body: JSON.stringify(message),
      });
      if (response.status === 409 && attempt === 0) {
        session = response.headers.get('X-Transmission-Session-Id');
        if (!session) throw new Error(t('Transmission 未提供会话编号，请检查反向代理配置'));
        continue;
      }
      return json(response);
    }
  }
  let info = await rpc('session-get');
  if (
    info.error?.code === -32601 ||
    info.error?.code === -32600 ||
    info.result === 'method name not recognized'
  ) {
    modern = true;
    info = await rpc('session-get');
  }
  const unwrap = (data) => {
    if (modern) {
      if (data.error || !data.result || typeof data.result !== 'object')
        throw new Error(t('Transmission 拒绝了请求，请检查种子和 RPC 设置'));
      return data.result;
    }
    if (data.result !== 'success' || !data.arguments)
      throw new Error(t('Transmission 拒绝了请求，请检查种子和 RPC 设置'));
    return data.arguments;
  };
  return { info: unwrap(info), call: async (method, args) => unwrap(await rpc(method, args)) };
}
async function aria(config, method, params = []) {
  const endpoint = /\/jsonrpc$/.test(config.url) ? config.url : config.url + '/jsonrpc';
  const result = await json(
    await http(endpoint, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'aria2.' + method,
        params: [...(config.secret ? ['token:' + config.secret] : []), ...params],
      }),
    }),
  );
  if (result.error)
    throw new Error(
      result.error.code === 1
        ? t('aria2 拒绝了请求，请检查 RPC 密钥、种子和保存目录')
        : t('aria2 接口错误，请检查 RPC 配置'),
    );
  return result.result;
}
const adapters = {
  qbittorrent: {
    async test(config) {
      await qbLogin(config);
      const response = await http(config.url + '/api/v2/app/version', { credentials: 'include' });
      const version = (await response.text()).trim();
      if (!response.ok || !/^v?\d+\.\d+[\w.+-]*$/.test(version))
        throw new Error(t('qBittorrent 版本接口无效'));
      return version;
    },
    async send(config, bytes, name) {
      await qbLogin(config);
      const body = new FormData();
      body.append('torrents', new Blob([bytes], { type: 'application/x-bittorrent' }), name);
      const response = await http(config.url + '/api/v2/torrents/add', {
        method: 'POST',
        credentials: 'include',
        body,
      });
      if (!response.ok || (await response.text()).trim() !== 'Ok.')
        throw new Error(t('qBittorrent 未接收种子，请检查文件内容和保存目录'));
      return {};
    },
  },
  transmission: {
    async test(config) {
      return (await transmissionSession(config)).info.version;
    },
    async send(config, bytes) {
      const session = await transmissionSession(config);
      const result = await session.call('torrent-add', { metainfo: bytesToBase64(bytes) });
      const added = result['torrent-added'] || result.torrent_added;
      const duplicate = result['torrent-duplicate'] || result.torrent_duplicate;
      if (!added && !duplicate) throw new Error(t('Transmission 未确认接收种子'));
      return { duplicate: Boolean(duplicate) };
    },
  },
  aria2: {
    async test(config) {
      return (await aria(config, 'getVersion'))?.version;
    },
    async send(config, bytes) {
      const gid = await aria(config, 'addTorrent', [bytesToBase64(bytes)]);
      if (typeof gid !== 'string' || !/^[a-f\d]{16}$/i.test(gid))
        throw new Error(t('aria2 未返回有效任务编号'));
      return { taskId: gid };
    },
  },
};
export async function testDownloader(value) {
  const config = normalizeDownloader(value);
  const version = await adapters[config.type].test(config);
  if (typeof version !== 'string' || !version || version.length > 100)
    throw new Error(t('下载器版本信息无效'));
  return { name: DOWNLOADERS[config.type].name, version };
}
export async function submitTorrent(value, bytes, name) {
  const config = normalizeDownloader(value);
  validateTorrent(bytes);
  return {
    name: DOWNLOADERS[config.type].name,
    ...(await adapters[config.type].send(config, bytes, name)),
  };
}
