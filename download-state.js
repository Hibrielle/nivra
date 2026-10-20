import { t } from './i18n.js';
// Chrome represents manual cancellation as interrupted + USER_CANCELED.
export const isCanceled = (record) =>
  record.state === 'interrupted' && record.error === 'USER_CANCELED';
const reasons = {
  FILE_FAILED: t('文件保存失败'),
  FILE_ACCESS_DENIED: t('没有写入此文件夹的权限'),
  FILE_NO_SPACE: t('磁盘空间不足，请先清理空间'),
  FILE_NAME_TOO_LONG: t('文件名过长'),
  FILE_TOO_LARGE: t('文件超过目标磁盘允许的大小'),
  FILE_VIRUS_INFECTED: t('浏览器安全检查拦截了此文件'),
  FILE_TRANSIENT_ERROR: t('文件暂时无法写入'),
  FILE_BLOCKED: t('浏览器阻止了此文件'),
  FILE_SECURITY_CHECK_FAILED: t('文件未通过安全检查'),
  FILE_TOO_SHORT: t('收到的文件内容不完整'),
  FILE_HASH_MISMATCH: t('文件校验失败'),
  FILE_SAME_AS_SOURCE: t('源文件和保存位置相同'),
  NETWORK_FAILED: t('网络连接失败'),
  NETWORK_TIMEOUT: t('网络连接超时'),
  NETWORK_DISCONNECTED: t('网络连接已断开'),
  NETWORK_SERVER_DOWN: t('下载服务器暂时不可用'),
  NETWORK_INVALID_REQUEST: t('下载请求无效'),
  SERVER_FAILED: t('服务器响应异常'),
  SERVER_NO_RANGE: t('服务器不支持断点续传'),
  SERVER_BAD_CONTENT: t('服务器没有返回有效文件'),
  SERVER_UNAUTHORIZED: t('需要登录来源网站后重新下载'),
  SERVER_CERT_PROBLEM: t('服务器证书验证失败'),
  SERVER_FORBIDDEN: t('服务器拒绝访问，请检查来源网站权限'),
  SERVER_UNREACHABLE: t('无法连接下载服务器'),
  SERVER_CONTENT_LENGTH_MISMATCH: t('收到的文件大小与服务器声明不符'),
  SERVER_CROSS_ORIGIN_REDIRECT: t('下载被跨站重定向中断'),
  USER_SHUTDOWN: t('浏览器关闭时下载中断'),
  CRASH: t('浏览器异常导致下载中断'),
};
export function downloadState(record) {
  if (isCanceled(record))
    return { kind: 'canceled', label: t('已取消'), symbol: 'close', detail: t('可重新下载') };
  if (record.state === 'interrupted') {
    const reason = reasons[record.error] || t('下载被中断，请查看任务详情');
    const needsAttention =
      /^(FILE_(ACCESS_DENIED|NO_SPACE|NAME_TOO_LONG|TOO_LARGE|VIRUS_INFECTED|BLOCKED|SECURITY_CHECK_FAILED|SAME_AS_SOURCE)|SERVER_(UNAUTHORIZED|CERT_PROBLEM|FORBIDDEN))$/.test(
        record.error || '',
      );
    return {
      kind: 'failed',
      label: t('下载中断'),
      symbol: 'info',
      detail:
        reason + (needsAttention ? '' : record.canResume ? t(' · 可继续下载') : t(' · 可重新下载')),
    };
  }
  if (record.state === 'complete')
    return record.exists === false
      ? { kind: 'missing', label: t('本地文件不存在'), symbol: 'close', detail: '' }
      : { kind: 'complete', label: t('已完成'), symbol: 'check', detail: '' };
  return record.paused
    ? { kind: 'paused', label: t('已暂停'), symbol: 'pause', detail: '' }
    : { kind: 'active', label: t('下载中'), symbol: null, detail: '' };
}
