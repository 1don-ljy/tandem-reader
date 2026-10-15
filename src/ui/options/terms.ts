import type { Rule } from '../../shared/types.ts';
import { MESSAGE_TYPES } from '../../shared/protocol.ts';
import type { OptionsRuntime } from '../context.ts';
import { $, actionButton, actionLabels, element, notice, scopeLabels } from '../dom.ts';
import { send } from '../messaging.ts';

export function updateRuleFields() {
  const needsTranslation = $('rule-action').value !== 'keep';
  const scope = $('rule-scope').value;
  const needsUrl = ['page', 'collection'].includes(scope);
  $('translation-field').hidden = !needsTranslation;
  $('rule-translation').required = needsTranslation;
  $('rule-translation').disabled = !needsTranslation;
  $('scope-url-field').hidden = !needsUrl;
  $('rule-scope-value').required = needsUrl;
  $('rule-scope-value').disabled = !needsUrl;
  $('scope-domain-field').hidden = scope !== 'domain';
  $('rule-domain').required = scope === 'domain';
  $('rule-domain').disabled = scope !== 'domain';
  $('scope-url-label').textContent = scope === 'page' ? '页面完整网址' : '文档网址前缀';
  $('scope-hint').textContent = scope === 'page'
    ? '仅对这一页面生效；网址中的 # 锚点不影响页面范围。'
    : '仅对这一网址路径下的文档生效，请保留结尾的 /。';
}

export function resetRule() {
  $('rule-form').reset();
  $('rule-id').value = '';
  $('rule-form-title').textContent = '添加术语规则';
  updateRuleFields();
}

export function editRule(rule: Rule) {
  $('rule-id').value = rule.id;
  $('rule-term').value = rule.term;
  $('rule-action').value = rule.action;
  $('rule-translation').value = rule.translation || '';
  $('rule-scope').value = rule.scope;
  $('rule-scope-value').value = ['page', 'collection'].includes(rule.scope) ? rule.scopeValue || '' : '';
  $('rule-domain').value = rule.domain || (rule.scope === 'domain' ? rule.scopeValue : '') || '';
  $('rule-form-title').textContent = '编辑术语规则';
  updateRuleFields();
  $('rule-term').focus();
}

export function renderRules(runtime: OptionsRuntime) {
  const list = $('rules');
  const query = $('rule-search').value.trim().toLocaleLowerCase();
  const rules = runtime.state.rules.filter((rule) => [rule.term, rule.translation, rule.scopeValue, rule.domain]
    .some((value) => String(value || '').toLocaleLowerCase().includes(query)));
  list.replaceChildren();
  if (!rules.length) list.append(element('div', 'empty-state', query ? '没有找到匹配的规则。' : '还没有术语规则。\n试试把 agent 设为“保留原文”。'));
  for (const rule of rules) {
    const row = element('article', 'rule-row');
    const title = element('div', 'rule-title');
    title.append(element('strong', '', rule.term), element('span', 'count-badge', actionLabels[rule.action] || rule.action));
    row.append(title);
    if (rule.translation) row.append(element('p', 'rule-details', `译法：${rule.translation}`));
    const scopeValue = rule.scope === 'domain' ? rule.domain || rule.scopeValue : rule.scopeValue;
    row.append(element('p', 'rule-details', `${scopeLabels[rule.scope] || rule.scope}${rule.scope === 'global' ? '' : ` · ${scopeValue || '未设置'}`}`));
    const actions = element('div', 'form-actions');
    actions.append(actionButton('编辑', 'text-button', () => editRule(rule)));
    actions.append(actionButton('删除', 'danger-button', async () => {
      await send(MESSAGE_TYPES.DELETE_RULE, { id: rule.id });
      if ($('rule-id').value === rule.id) resetRule();
      await runtime.reloadState();
      notice(`已删除「${rule.term}」的规则。`);
    }));
    row.append(actions);
    list.append(row);
  }
}

export function bindRules(runtime: OptionsRuntime): void {
  $('new-rule').addEventListener('click', () => { resetRule(); $('rule-term').focus(); });
  $('cancel-rule').addEventListener('click', resetRule);
  $('rule-action').addEventListener('change', updateRuleFields);
  $('rule-scope').addEventListener('change', updateRuleFields);
  $('rule-search').addEventListener('input', () => renderRules(runtime));
  $('rule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const scope = $('rule-scope').value as Rule['scope'];
    const rule: Omit<Rule, 'id'> & { id?: string } = {
      term: $('rule-term').value.trim(),
      action: $('rule-action').value as Rule['action'],
      translation: $('rule-action').value === 'keep' ? '' : $('rule-translation').value.trim(),
      scope,
      scopeValue: scope === 'global' ? '' : scope === 'domain' ? $('rule-domain').value.trim() : $('rule-scope-value').value.trim(),
      domain: scope === 'domain' ? $('rule-domain').value.trim() : '',
    };
    if ($('rule-id').value) rule.id = $('rule-id').value;
    if (!rule.term) return notice('请填写原文术语。', true);
    if (rule.action !== 'keep' && !rule.translation) return notice('请填写中文译法。', true);
    if (rule.scope !== 'global' && !rule.scopeValue) return notice('请填写规则的应用范围。', true);
    $('save-rule').disabled = true;
    try {
      await send(MESSAGE_TYPES.SAVE_RULE, { rule });
      await runtime.reloadState();
      resetRule();
      notice(`已保存「${rule.term}」。后续翻译将遵循此规则。`);
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
    finally { $('save-rule').disabled = false; }
  });
}
