import { validateRule } from '../shared/core.ts';
import type { Rule, RuleInput } from '../shared/types.ts';
import { notifyPages } from './page-context.ts';
import { readData, serialWrite, type Page } from './store.ts';

export async function saveRule(input: RuleInput, page: Page | null) {
  const rule = validateRule(input);
  if (page && rule.scope === 'page' && rule.scopeValue !== page.url) throw new Error('页面规则只能应用于当前页面。');
  if (page && rule.scope === 'collection') {
    const current = new URL(page.url), scope = new URL(rule.scopeValue);
    if (scope.origin !== current.origin || !current.pathname.startsWith(scope.pathname)) throw new Error('文档集路径必须包含当前页面。');
  }
  let saved: Rule | undefined, previousRule: Rule | null = null;
  await serialWrite(async () => {
    const data = await readData();
    const duplicate = data.rules.find(item => item.term.toLowerCase() === rule.term.toLowerCase() && item.scope === rule.scope && item.scopeValue === rule.scopeValue && item.id !== input.id);
    if (input.id && !data.rules.some(item => item.id === input.id)) throw new Error('规则已不存在，请刷新列表。');
    if (input.id && duplicate) throw new Error('相同范围已有该术语，请编辑已有规则。');
    previousRule = data.rules.find(item => item.id === input.id) || duplicate || null;
    saved = { ...rule, id: input.id || duplicate?.id || crypto.randomUUID() };
    const rules = data.rules.filter(item => item.id !== saved?.id);
    if (rules.length >= 1000) throw new Error('规则数量已达 1000 条，请先整理现有规则。');
    rules.push(saved);
    await chrome.storage.local.set({ rules, revision: data.revision + 1 });
  });
  await notifyPages();
  // `serialWrite` rejects before returning when the write fails, so `saved` is always set here.
  return { rule: saved as Rule, previousRule };
}
