import { t } from './i18n.js';
import { decide, validateRule, renderPath, compileFilenameRegex } from './engine.js';
import { explainRules } from './rules.js';
import { evaluateExpression } from './expressions.js';
export function evaluateOperation(operation, payload) {
  if (operation === 'resourceFilter') {
    const re = compileFilenameRegex(payload.regex);
    return payload.items
      .filter((item) => re.test(item.filename + ' ' + item.url))
      .map((item) => item.id);
  }
  if (operation === 'decide') return decide(payload.item, payload.config);
  if (operation === 'explain') return explainRules(payload.item, payload.config);
  if (operation === 'previewRule')
    return {
      single: decide(payload.item, {
        ...payload.config,
        enabled: true,
        matchMode: 'first',
        rules: [
          { ...payload.rule, enabled: true },
          ...payload.config.rules
            .filter((rule) => rule.id !== payload.rule.id)
            .map((rule) => ({ ...rule, enabled: false })),
        ],
      }),
      actual: explainRules(payload.item, payload.config).decision,
    };
  if (operation === 'simulate')
    return payload.samples.map((item) => ({
      filename: item.filename,
      ...explainRules(item, payload.config),
    }));
  if (operation === 'filter')
    return payload.items
      .filter((item) => evaluateExpression(payload.condition, item, payload.config))
      .map((item) => item.id);
  if (operation === 'validate') return validateRule(payload.rule);
  if (operation === 'template')
    return renderPath(payload.template, payload.item, payload.captures || {}, payload.archiveRoot);
  throw new Error(t('未知规则计算操作'));
}
