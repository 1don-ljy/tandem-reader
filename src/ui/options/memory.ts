import type { DocumentMemory } from '../../shared/types.ts';
import { MESSAGE_TYPES } from '../../shared/protocol.ts';
import type { OptionsRuntime } from '../context.ts';
import { $, actionButton, actionLabels, element, notice } from '../dom.ts';
import { send } from '../messaging.ts';
import { editRule } from './terms.ts';

export function updateMemoryFields() {
  const isPage = $('memory-scope').value === 'page';
  $('memory-scope-label').textContent = isPage ? '页面完整网址' : '文档网址前缀';
  $('memory-scope-hint').textContent = isPage
    ? '仅在这一页面载入；页面记忆优先于文档集记忆。'
    : '在此网址路径下的页面载入；更具体的文档路径优先。';
}

export function resetMemory() {
  $('memory-form').reset();
  $('memory-id').value = '';
  $('memory-form-title').textContent = '添加人工领域记忆';
  updateMemoryFields();
}

export function editMemory(memory: DocumentMemory) {
  $('memory-id').value = memory.id;
  $('memory-scope').value = memory.scope;
  $('memory-scope-value').value = memory.scopeValue;
  $('memory-domain').value = memory.domain;
  $('memory-context').value = memory.context;
  $('memory-form-title').textContent = '编辑人工领域记忆';
  updateMemoryFields();
  $('memory-domain').focus();
}

export function renderMemories(runtime: OptionsRuntime) {
  const list = $('memories');
  list.replaceChildren();
  if (!runtime.state.memories.length) list.append(element('div', 'empty-state', '还没有人工领域记忆。\n在网页中修改领域后勾选“记住我的修改”，或在右侧添加。'));
  for (const memory of runtime.state.memories) {
    const row = element('article', 'rule-row');
    const title = element('div', 'rule-title');
    title.append(element('strong', '', memory.domain), element('span', 'count-badge', memory.scope === 'page' ? '当前页面' : '这套文档'));
    row.append(title, element('p', 'rule-details', memory.scopeValue));
    if (memory.context) row.append(element('p', 'skip-text', memory.context));
    const actions = element('div', 'form-actions');
    actions.append(actionButton('编辑', 'text-button', () => editMemory(memory)));
    actions.append(actionButton('删除', 'danger-button', async () => {
      await send(MESSAGE_TYPES.DELETE_MEMORY, { id: memory.id });
      if ($('memory-id').value === memory.id) resetMemory();
      await runtime.reloadState();
      notice('已删除这条领域记忆。后续打开文档时不再自动载入。');
    }));
    row.append(actions);
    list.append(row);
  }
}

export function renderDomainMemories(runtime: OptionsRuntime) {
  const list = $('domain-memories');
  list.replaceChildren();
  $('domain-memory-count').textContent = String(runtime.state.domainMemories.length);
  if (!runtime.state.domainMemories.length) list.append(element('p', 'field-hint', '尚未生成自动领域记忆。启用自动识别并开始翻译后，会在这里显示分析结果。'));
  for (const memory of runtime.state.domainMemories) {
    const row = element('article', 'rule-row');
    const title = element('div', 'rule-title');
    title.append(element('strong', '', memory.domain), element('span', 'count-badge', `已分析 ${memory.documents.length} 篇文档`));
    row.append(title, element('p', 'rule-details', memory.scopeValue));
    if (memory.context) row.append(element('p', 'auto-memory-context', memory.context));
    const details = element('details', 'auto-terms');
    details.append(element('summary', '', `查看 ${memory.terms.length} 个术语与判断依据`));
    for (const term of memory.terms) {
      const entry = element('article', 'auto-term');
      const heading = element('div', 'rule-title');
      heading.append(element('strong', '', term.term), element('span', 'count-badge', actionLabels[term.action]));
      entry.append(heading);
      const translation = term.action === 'keep'
        ? `保留原文 ${term.term}`
        : term.action === 'first' ? `${term.translation}（${term.term}），后续保留原文` : term.translation;
      entry.append(element('p', 'field-hint', `自动译法：${translation}`));
      entry.append(element('p', 'field-hint', `语境含义：${term.meaning}`));
      const evidence = element('details', 'term-evidence');
      evidence.append(element('summary', '', '判断依据'), element('p', 'field-hint', term.evidence || '未提供依据。'));
      entry.append(evidence);
      entry.append(actionButton('纠正为人工规则', 'text-button', () => {
        const existing = runtime.state.rules.find((rule) => rule.term.toLocaleLowerCase() === term.term.toLocaleLowerCase() && rule.scope === 'collection' && rule.scopeValue === memory.scopeValue);
        editRule(existing || { id: '', term: term.term, action: term.action, translation: term.translation.slice(0, 160), scope: 'collection', scopeValue: memory.scopeValue, domain: memory.domain });
        $('rule-form-title').textContent = existing ? '编辑人工规则' : '纠正自动术语';
        $('rule-form').scrollIntoView({ block: 'center' });
        notice('已填入规则编辑器。调整后点击“保存规则”，人工规则将优先于自动译法。');
      }));
      details.append(entry);
    }
    row.append(details);
    const documents = element('details', 'auto-documents');
    documents.append(element('summary', '', '已分析的文档'));
    for (const document of memory.documents) documents.append(element('p', 'rule-details', document.url));
    row.append(documents);
    const actions = element('div', 'form-actions');
    actions.append(actionButton('删除自动记忆', 'danger-button', async () => {
      await send(MESSAGE_TYPES.DELETE_DOMAIN_MEMORY, { id: memory.id });
      await runtime.reloadState();
      notice('自动领域记忆已删除。若启用自动识别，下次开始翻译时会重新分析。');
    }));
    row.append(actions);
    list.append(row);
  }
}

export function bindMemory(runtime: OptionsRuntime): void {
  $('new-memory').addEventListener('click', () => { resetMemory(); $('memory-domain').focus(); });
  $('cancel-memory').addEventListener('click', resetMemory);
  $('memory-scope').addEventListener('change', updateMemoryFields);
  $('memory-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const scope = $('memory-scope').value;
    if (scope !== 'page' && scope !== 'collection') return;
    const memory: Omit<DocumentMemory, 'id' | 'updatedAt'> & { id?: string } = {
      scope,
      scopeValue: $('memory-scope-value').value.trim(),
      domain: $('memory-domain').value.trim(),
      context: $('memory-context').value.trim(),
    };
    if ($('memory-id').value) memory.id = $('memory-id').value;
    if (!memory.domain || !memory.scopeValue) return notice('请填写领域名称与适用网址。', true);
    $('save-memory').disabled = true;
    try {
      await send(MESSAGE_TYPES.SAVE_MEMORY, { memory });
      await runtime.reloadState();
      resetMemory();
      notice('人工领域记忆已保存。打开对应文档时会优先载入。');
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
    finally { $('save-memory').disabled = false; }
  });
}
