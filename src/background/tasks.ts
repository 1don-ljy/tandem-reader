import { runTranslationAgent } from '../agent/translation-agent.ts';
import { applicableRules, normalizeEndpoint, normalizeText, protectTerms, restoreTerms, translationMessages } from '../shared/core.ts';
import { ANALYSIS_VERSION, analysisMessages, glossaryContext, parseDomainAnalysis, rulesWithDomainMemory } from '../shared/domain-analysis.ts';
import { requireNonEmptyText, requireText, requireTextList, type AnalysisRequest, type TranslationRequest } from '../shared/protocol.ts';
import { resolveProvider } from '../shared/providers.ts';
import { FORMAT_VERSION, normalizeTranslationOutput } from '../shared/translation-output.ts';
import type { AppData, ChatMessage, Connection, SessionTurn } from '../shared/types.ts';
import { effectiveSettings, notifyPages, pageContext } from './page-context.ts';
import { controllers, memory, readData, readKeys, serialWrite, type CacheEntry, type Page } from './store.ts';

export async function selectedProfile(data: AppData, id = data.settings.activeProfileId): Promise<Connection> {
  const profile = data.profiles.find(item => item.id === id);
  if (!profile) throw new Error('请先在设置页添加并选择模型配置。');
  const endpoint = normalizeEndpoint(profile.baseUrl);
  resolveProvider(profile.provider, profile.baseUrl);
  if (!(await chrome.permissions.contains({ origins: [endpoint.origin] }))) throw new Error('尚未授权此模型接口，请在设置页保存配置并允许访问。');
  const keys = await readKeys();
  const apiKey = keys[profile.keyPersistence]?.[profile.id] || '';
  if (!apiKey && !endpoint.local) throw new Error('此模型缺少 API Key；会话密钥在浏览器或扩展重新启动后需要再次填写。');
  return { profile, ...endpoint, apiKey };
}

export async function complete(connection: Connection, messages: ChatMessage[], requestKey?: string, existingController?: AbortController, history: SessionTurn[] = []) {
  const controller = existingController || new AbortController();
  if (requestKey && !existingController) {
    controllers.get(requestKey)?.abort();
    controllers.set(requestKey, controller);
  }
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25000);
  try {
    if (controller.signal.aborted) throw new Error('翻译已停止。');
    return await runTranslationAgent(connection, messages, controller.signal, history);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(timedOut ? '模型请求超过 25 秒，请重试此段或使用响应更快的模型。' : '翻译已停止或规则已更新。');
    if (error instanceof TypeError) throw new Error('无法连接模型接口，请检查网址、网络、访问授权和服务是否运行。');
    throw error;
  } finally {
    clearTimeout(timeout);
    if (requestKey && !existingController && controllers.get(requestKey) === controller) controllers.delete(requestKey);
  }
}

export async function cacheHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function analyzeDocument(message: AnalysisRequest, page: Page) {
  const jobId = requireNonEmptyText(message.jobId, 120, '文档分析任务标识无效。');
  const sample = requireNonEmptyText(message.sample, 12000, '文档分析样本无效或过长。');
  const documentTitle = requireText(message.documentTitle, 500, '文档分析样本无效或过长。');
  const headings = requireTextList(message.headings, 200, 30, '文档分析样本无效或过长。');
  const jobKey = `job:${page.tabId}:${jobId}`, controller = new AbortController();
  controllers.get(jobKey)?.abort();
  controllers.set(jobKey, controller);
  try {
    const data = await readData(), effective = await effectiveSettings(data, page);
    if (!data.settings.autoDiscover) return { context: await pageContext(page), reused: true };
    const connection = await selectedProfile(data);
    const fingerprint = await cacheHash([ANALYSIS_VERSION, documentTitle, headings, sample, connection.profile, data.settings.targetLanguage, effective.manualContext ? [effective.settings.domain, effective.settings.context] : null]);
    if (controller.signal.aborted) throw new Error('文档分析已停止。');
    if (effective.domainMemory?.documents.some(document => document.url === page.url && document.fingerprint === fingerprint)) return { context: await pageContext(page), reused: true };
    try {
      const previous = effective.domainMemory && (!effective.manualContext || effective.domainMemory.domain.toLowerCase() === effective.settings.domain.toLowerCase()) ? effective.domainMemory : undefined;
      const output = await complete(connection, analysisMessages({ documentTitle, headings, sample }, effective.settings, previous, effective.manualContext), jobKey, controller);
      const analysis = parseDomainAnalysis(output, sample);
      if (effective.manualContext) analysis.domain = effective.settings.domain;
      let changed = false;
      await serialWrite(async () => {
        const current = await readData();
        if (controller.signal.aborted) throw new Error('文档分析已停止。');
        if (current.revision !== data.revision) throw new Error('翻译设置已变化，请重新开始。');
        const stored = await memory.saveDomainAnalysis({ url: page.url, fingerprint, ...analysis });
        const knowledge = (value?: import('../shared/types.js').DomainMemory) => value ? [value.domain, value.context, value.terms.map(term => [term.term.toLowerCase(), term.action, term.translation, term.meaning]).sort((a, b) => a[0].localeCompare(b[0]))] : null;
        changed = JSON.stringify(knowledge(effective.domainMemory)) !== JSON.stringify(knowledge(stored));
        if (changed) await chrome.storage.local.set({ revision: current.revision + 1 });
      });
      if (changed) await notifyPages(page.tabId);
      return { context: await pageContext(page), reused: false };
    } catch (error) {
      if (controller.signal.aborted) throw new Error('文档分析已停止或设置已更新。');
      if ((await readData()).revision !== data.revision) throw new Error('翻译设置已变化，请重新开始。');
      return { context: await pageContext(page), reused: false, warning: `自动领域分析未完成，继续使用已有背景和规则。${error instanceof Error ? error.message.slice(0, 300) : '请稍后重试。'}` };
    }
  } finally {
    if (controllers.get(jobKey) === controller) controllers.delete(jobKey);
  }
}

export async function translate(message: TranslationRequest, page: Page) {
  requireNonEmptyText(message.text, 16000, '段落为空或超过 16000 字符，请选择较短的段落。');
  requireText(message.jobId, 120, '翻译任务标识无效，请重新开始。');
  const jobKey = `job:${page.tabId}:${message.jobId}`;
  const controller = new AbortController();
  controllers.get(jobKey)?.abort();
  controllers.set(jobKey, controller);
  try {
    return await translateRequest(message, page, jobKey, controller);
  } finally {
    if (controllers.get(jobKey) === controller) controllers.delete(jobKey);
  }
}

export async function translateRequest(message: TranslationRequest, page: Page, jobKey: string, controller: AbortController) {
  const data = await readData();
  const { settings, domainMemory: storedDomainMemory } = await effectiveSettings(data, page);
  const domainMemory = settings.autoDiscover && normalizeText(storedDomainMemory?.domain).toLowerCase() === normalizeText(settings.domain).toLowerCase() ? storedDomainMemory : undefined;
  const connection = await selectedProfile(data);
  const job = (await chrome.storage.session.get(jobKey))[jobKey] as { seen: string[] } | undefined;
  const rules = rulesWithDomainMemory(applicableRules(data.rules, page.url, settings.domain), settings.autoDiscover ? domainMemory : undefined);
  const seen = Array.isArray(message.seenTerms)
    ? message.seenTerms.slice(0, 1000).filter(id => rules.some(rule => rule.id === id))
    : job?.seen || [];
  const protectedData = protectTerms(message.text, rules, seen, crypto.randomUUID().replaceAll('-', ''));
  const heading = String(message.heading || '').slice(0, 1000);
  const title = String(message.documentTitle || '').slice(0, 500);
  const { mode, ...translationSettings } = settings;
  const identity = await cacheHash([FORMAT_VERSION, connection.profile, translationSettings, data.revision]);
  const documentSession = await memory.readSession(page.url, identity);
  const hash = await cacheHash([FORMAT_VERSION, page.url, message.text, heading, title, translationSettings, connection.profile, data.revision, seen]);
  const cacheKey = `cache:${hash}`;
  const cached = (await chrome.storage.session.get(cacheKey))[cacheKey] as CacheEntry | undefined;
  if (controller.signal.aborted) throw new Error('翻译已停止或规则已更新。');
  if (cached) {
    await chrome.storage.session.set({ [jobKey]: { seen: cached.seen, at: Date.now() } });
    return { text: cached.text, cached: true };
  }
  const translated = await complete(connection, translationMessages(glossaryContext(settings, settings.autoDiscover ? domainMemory : undefined, message.plainText || message.text), protectedData.text, heading, title), jobKey, controller, documentSession?.turns || []);
  const text = restoreTerms(normalizeTranslationOutput(translated, message.text), protectedData);
  // A concurrent edit invalidates the response even if it arrived just before abort.
  if ((await readData()).revision !== data.revision) throw new Error('翻译规则已变化，请更新译文。');
  if (controller.signal.aborted) throw new Error('翻译已停止或规则已更新。');
  const plainSource = message.plainText || message.text.replace(/\[\[DOC_CODE_\d+\]\]/g, '[代码或链接]');
  const plainTranslation = text.replace(/\[\[DOC_CODE_(\d+)\]\]/g, (_, index: string) => message.codeTexts?.[Number(index)] || '[代码或链接]');
  await memory.appendTurn(page.url, identity, { source: plainSource, translation: plainTranslation, heading, at: Date.now() });
  await trimSession();
  try {
    await chrome.storage.session.set({
      [jobKey]: { seen: protectedData.seenTerms, at: Date.now() },
      [cacheKey]: { text, seen: protectedData.seenTerms, at: Date.now() }
    });
  } catch {
    // Cache is an optimization; a storage quota must not discard a valid translation.
  }
  return { text, cached: false };
}

export async function trimSession() {
  const all = await chrome.storage.session.get(null) as Record<string, { at?: number }>;
  for (const [prefix, limit] of [['cache:', 180], ['job:', 40]] as const) {
    const entries = Object.entries(all).filter(([key]) => key.startsWith(prefix)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const remove = entries.slice(limit).map(([key]) => key);
    if (remove.length) await chrome.storage.session.remove(remove);
  }
  const cached = Object.entries(all).filter(([key]) => key.startsWith('cache:')).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  let bytes = 0;
  const overflow = [];
  for (const [key, value] of cached) {
    bytes += new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > 3 * 1024 * 1024) overflow.push(key);
  }
  if (overflow.length) await chrome.storage.session.remove(overflow);
}
