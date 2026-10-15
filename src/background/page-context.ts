import { applicableRules, normalizeText, pageUrl } from '../shared/core.ts';
import { rulesWithDomainMemory } from '../shared/domain-analysis.ts';
import type { AppData, DocumentMemory, DomainMemory, PageContext, Settings } from '../shared/types.ts';
import { MESSAGE_TYPES, sendToTab } from '../shared/protocol.ts';
import { abortOtherJobs, memory, readData, type Page } from './store.ts';

export function isUi(sender: chrome.runtime.MessageSender): boolean {
  try {
    const url = new URL(sender.url || '');
    url.hash = ''; url.search = '';
    return ['popup.html', 'options.html'].some(path => url.href === chrome.runtime.getURL(path));
  } catch { return false; }
}

export async function authorizedPage(sender: chrome.runtime.MessageSender): Promise<Page> {
  if (!sender.tab?.id || (sender.frameId !== undefined && sender.frameId !== 0)) throw new Error('只允许已启用的顶层网页操作。');
  const url = pageUrl(sender.url || sender.tab.url || '');
  const key = `allowed:${sender.tab.id}`;
  const allowed = (await chrome.storage.session.get(key))[key];
  if (allowed !== url) throw new Error('请从插件按钮为当前页面启用翻译。');
  return { tabId: sender.tab.id, url };
}

export async function activeTab(): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('找不到当前标签页。');
  pageUrl(tab.url || '');
  return { ...tab, id: tab.id, url: tab.url || '' };
}

export async function inject(tab: chrome.tabs.Tab & { id: number; url: string }) {
  await chrome.storage.session.set({ [`allowed:${tab.id}`]: pageUrl(tab.url) });
  await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
}

export async function notifyPages(exceptTabId?: number) {
  abortOtherJobs(exceptTabId);
  const session = await chrome.storage.session.get(null);
  await Promise.all(Object.keys(session).filter(key => key.startsWith('allowed:')).map(async key => {
    if (Number(key.slice(8)) === exceptTabId) return;
    try { await sendToTab(Number(key.slice(8)), MESSAGE_TYPES.RULES_CHANGED, {}); } catch { /* A closed or navigated tab has no content listener. */ }
  }));
}

export async function effectiveSettings(data: AppData, page: Page): Promise<{ settings: Settings; memory?: DocumentMemory; domainMemory?: DomainMemory; manualContext: boolean; contextSource: 'manual-session' | 'manual-memory' | 'automatic' | 'default' }> {
  const [stored, domainMemory] = await Promise.all([memory.findMemory(page.url), memory.findDomainMemory(page.url)]);
  const key = `context:${page.tabId}`;
  const override = (await chrome.storage.session.get(key))[key] as { url: string; domain: string; context: string } | undefined;
  const context = override?.url === page.url ? override : stored;
  const background = context || (data.settings.autoDiscover ? domainMemory : undefined);
  const contextSource = override?.url === page.url ? 'manual-session' : stored ? 'manual-memory' : data.settings.autoDiscover && domainMemory ? 'automatic' : 'default';
  return { settings: { ...data.settings, ...(background ? { domain: background.domain, context: background.context } : {}) }, manualContext: Boolean(context), contextSource, ...(stored ? { memory: stored } : {}), ...(domainMemory ? { domainMemory } : {}) };
}

export async function pageContext(page: Page): Promise<PageContext> {
  const data = await readData(), effective = await effectiveSettings(data, page);
  const rules = applicableRules(data.rules, page.url, effective.settings.domain);
  const domainMemory = effective.settings.autoDiscover && normalizeText(effective.domainMemory?.domain).toLowerCase() === normalizeText(effective.settings.domain).toLowerCase() ? effective.domainMemory : undefined;
  return { ...effective, rules: rulesWithDomainMemory(rules, domainMemory), skips: data.skips.filter(skip => skip.url === page.url), profileConfigured: data.profiles.some(profile => profile.id === data.settings.activeProfileId) };
}

export function requirePage(page: Page | null): Page {
  if (!page) throw new Error('此操作需要从正在阅读的网页发起。');
  return page;
}
