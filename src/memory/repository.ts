import type { DocumentMemory, DocumentSession, DomainMemory, DomainTerm, MemoryInput, SessionSummary, SessionTurn } from '../shared/types.ts';

export interface StoragePort {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const MEMORY_LIMIT = 100;
const SESSION_LIMIT = 30;
const TURN_LIMIT = 3;
const TEXT_LIMIT = 4000;
const DOMAIN_MEMORY_LIMIT = 50;
const DOMAIN_TERM_LIMIT = 80;
const DOMAIN_DOCUMENT_LIMIT = 20;
const PLACEHOLDER = /\[\[(?:DTR|DOC_CODE)_/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
}

function documentUrl(value: unknown, collection = false): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('请填写有效的文档网址。');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('文档记忆仅支持不含账号密码的 HTTP / HTTPS 网址。');
  url.hash = '';
  if (collection) {
    url.search = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
  }
  return url.href;
}

function memoryFields(value: unknown): Omit<DocumentMemory, 'id' | 'updatedAt'> {
  if (!isRecord(value) || (value.scope !== 'page' && value.scope !== 'collection')) throw new Error('请选择页面或文档集作为记忆范围。');
  if (typeof value.domain !== 'string' || !value.domain.trim() || value.domain.trim().length > 100) throw new Error('领域名称需为 1–100 个字符。');
  if (typeof value.context !== 'string' || value.context.length > 3000) throw new Error('领域背景不能超过 3000 个字符。');
  return {
    scope: value.scope,
    scopeValue: documentUrl(value.scopeValue, value.scope === 'collection'),
    domain: value.domain.trim(),
    context: value.context.trim(),
  };
}

function storedMemory(value: unknown): DocumentMemory | undefined {
  if (!isRecord(value) || !validId(value.id) || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return;
  try { return { ...memoryFields(value), id: value.id, updatedAt: value.updatedAt }; }
  catch { return; }
}

function cleanTurn(value: unknown): SessionTurn | undefined {
  if (!isRecord(value) || typeof value.source !== 'string' || typeof value.translation !== 'string' || typeof value.heading !== 'string' ||
      typeof value.at !== 'number' || !Number.isFinite(value.at) || value.at < 0) return;
  const source = value.source.trim();
  const translation = value.translation.trim();
  if (!source || !translation || source.length > TEXT_LIMIT || translation.length > TEXT_LIMIT ||
      PLACEHOLDER.test(source) || PLACEHOLDER.test(translation) || PLACEHOLDER.test(value.heading)) return;
  return { source, translation, heading: value.heading.slice(0, 1000), at: value.at };
}

function sessionIdentity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('文档会话标识无效。');
  return value;
}

function storedSession(value: unknown): DocumentSession | undefined {
  if (!isRecord(value) || !validId(value.id) || !Array.isArray(value.turns) ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return;
  try {
    const turns = value.turns.map(cleanTurn).filter((turn): turn is SessionTurn => Boolean(turn)).slice(-TURN_LIMIT);
    if (!turns.length) return;
    return { id: value.id, url: documentUrl(value.url), identity: sessionIdentity(value.identity), turns, updatedAt: value.updatedAt };
  } catch { return; }
}

function domainText(value: unknown, limit: number, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value.trim()) ||
      PLACEHOLDER.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new Error(`自动领域记忆中的${label}无效或超过 ${limit} 个字符。`);
  }
  return value.trim();
}

function domainFields(value: unknown): { domain: string; context: string; terms: DomainTerm[] } {
  if (!isRecord(value) || !Array.isArray(value.terms) || value.terms.length > DOMAIN_TERM_LIMIT) throw new Error('自动领域术语格式无效或超过 80 条。');
  const terms = new Map<string, DomainTerm>();
  for (const item of value.terms) {
    if (!isRecord(item) || typeof item.action !== 'string' || !['keep', 'first', 'translate'].includes(item.action)) throw new Error('自动术语处理方式无效。');
    const action = item.action as DomainTerm['action'];
    const term = domainText(item.term, 120, '术语');
    const key = term.toLowerCase();
    terms.delete(key);
    terms.set(key, {
      term, action,
      translation: domainText(item.translation, 300, '译名', action === 'keep'),
      meaning: domainText(item.meaning, 500, '含义'),
      evidence: domainText(item.evidence, 300, '依据'),
    });
  }
  return { domain: domainText(value.domain, 100, '领域').replace(/\s+/g, ' '), context: domainText(value.context, 3000, '背景'), terms: [...terms.values()] };
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) throw new Error('文档指纹格式无效。');
  return value.toLowerCase();
}

function documentCollection(url: string): string {
  const result = new URL(url);
  result.search = '';
  result.pathname = result.pathname.slice(0, result.pathname.lastIndexOf('/') + 1);
  return result.href;
}

function belongsToCollection(url: string, scopeValue: string): boolean {
  const current = new URL(url), scope = new URL(scopeValue);
  return current.origin === scope.origin && current.pathname.startsWith(scope.pathname);
}

function storedDomainMemory(value: unknown): DomainMemory | undefined {
  if (!isRecord(value) || !validId(value.id) || !Array.isArray(value.documents) || value.documents.length > DOMAIN_DOCUMENT_LIMIT ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) return;
  try {
    const fields = domainFields(value);
    const scopeValue = documentUrl(value.scopeValue, true);
    const documents = new Map<string, { url: string; fingerprint: string }>();
    for (const item of value.documents) {
      if (!isRecord(item)) throw new Error('文档指纹记录无效。');
      const url = documentUrl(item.url);
      if (!belongsToCollection(url, scopeValue)) throw new Error('文档不属于此自动领域记忆。');
      documents.set(url, { url, fingerprint: fingerprint(item.fingerprint) });
    }
    return { ...fields, id: value.id, scopeValue, documents: [...documents.values()], updatedAt: value.updatedAt };
  } catch { return; }
}

export function validateMemories(input: unknown): DocumentMemory[] {
  if (!Array.isArray(input) || input.length > MEMORY_LIMIT) throw new Error('文档记忆格式无效或超过 100 条。');
  const memories = input.map(storedMemory);
  if (memories.some(item => !item)) throw new Error('导入文件中存在无效的文档记忆。');
  const valid = memories as DocumentMemory[];
  if (new Set(valid.map(item => item.id)).size !== valid.length ||
      new Set(valid.map(item => `${item.scope}:${item.scopeValue}`)).size !== valid.length) throw new Error('导入文件中存在重复的文档记忆。');
  return valid;
}

export class MemoryRepository {
  private queue: Promise<void> = Promise.resolve();

  private readonly storage: StoragePort;

  constructor(storage: StoragePort = chrome.storage.local) {
    this.storage = storage;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async listMemories(): Promise<DocumentMemory[]> {
    const { documentMemories } = await this.storage.get('documentMemories');
    if (!Array.isArray(documentMemories)) return [];
    const records = documentMemories.map(storedMemory).filter((item): item is DocumentMemory => Boolean(item));
    const seen = new Set<string>();
    const ids = new Set<string>();
    return records.sort((a, b) => b.updatedAt - a.updatedAt).filter(item => {
      const key = `${item.scope}:${item.scopeValue}`;
      if (seen.has(key) || ids.has(item.id)) return false;
      seen.add(key);
      ids.add(item.id);
      return true;
    }).slice(0, MEMORY_LIMIT);
  }

  async findMemory(url: string): Promise<DocumentMemory | undefined> {
    const current = new URL(documentUrl(url));
    const matches = (await this.listMemories()).filter(memory => {
      if (memory.scope === 'page') return memory.scopeValue === current.href;
      const scope = new URL(memory.scopeValue);
      return scope.origin === current.origin && current.pathname.startsWith(scope.pathname);
    });
    return matches.sort((a, b) => Number(b.scope === 'page') - Number(a.scope === 'page') || b.scopeValue.length - a.scopeValue.length)[0];
  }

  async saveMemory(input: MemoryInput): Promise<DocumentMemory> {
    const fields = memoryFields(input);
    if (input.id !== undefined && !validId(input.id)) throw new Error('文档记忆 ID 无效。');
    return this.mutate(async () => {
      const memories = await this.listMemories();
      const existing = memories.find(item => item.id === input.id);
      if (input.id && !existing) throw new Error('文档记忆已不存在，请刷新后重试。');
      const duplicate = memories.find(item => item.scope === fields.scope && item.scopeValue === fields.scopeValue && item.id !== input.id);
      if (existing && duplicate) throw new Error('相同范围已有文档记忆，请编辑已有记录。');
      const memory = { ...fields, id: existing?.id || duplicate?.id || crypto.randomUUID(), updatedAt: Date.now() };
      const next = memories.filter(item => item.id !== memory.id);
      if (next.length >= MEMORY_LIMIT) throw new Error('文档记忆已达 100 条，请先删除不再使用的记录。');
      await this.storage.set({ documentMemories: [...next, memory] });
      return memory;
    });
  }

  async deleteMemory(id: string): Promise<void> {
    await this.mutate(async () => {
      const memories = await this.listMemories();
      await this.storage.set({ documentMemories: memories.filter(item => item.id !== id) });
    });
  }

  async replaceMemories(input: DocumentMemory[]): Promise<void> {
    const valid = validateMemories(input);
    await this.mutate(() => this.storage.set({ documentMemories: valid }));
  }

  async listDomainMemories(): Promise<DomainMemory[]> {
    const { domainMemories } = await this.storage.get('domainMemories');
    if (!Array.isArray(domainMemories)) return [];
    const seen = new Set<string>(), ids = new Set<string>();
    return domainMemories.map(storedDomainMemory).filter((memory): memory is DomainMemory => Boolean(memory))
      .sort((a, b) => b.updatedAt - a.updatedAt).filter(memory => {
        if (seen.has(memory.scopeValue) || ids.has(memory.id)) return false;
        seen.add(memory.scopeValue);
        ids.add(memory.id);
        return true;
      }).slice(0, DOMAIN_MEMORY_LIMIT);
  }

  async findDomainMemory(url: string): Promise<DomainMemory | undefined> {
    const current = documentUrl(url);
    return (await this.listDomainMemories()).filter(memory => belongsToCollection(current, memory.scopeValue))
      .sort((a, b) => b.scopeValue.length - a.scopeValue.length)[0];
  }

  async saveDomainAnalysis(input: { url: string; fingerprint: string; domain: string; context: string; terms: DomainTerm[] }): Promise<DomainMemory> {
    const fields = domainFields(input);
    const url = documentUrl(input.url), scopeValue = documentCollection(url);
    const document = { url, fingerprint: fingerprint(input.fingerprint) };
    return this.mutate(async () => {
      const memories = await this.listDomainMemories();
      const existing = memories.find(memory => memory.scopeValue === scopeValue);
      const previous = existing?.domain.toLowerCase() === fields.domain.toLowerCase() ? existing : undefined;
      const terms = new Map<string, DomainTerm>((previous?.terms || []).map(term => [term.term.toLowerCase(), term]));
      for (const term of fields.terms) {
        const key = term.term.toLowerCase();
        terms.delete(key);
        terms.set(key, term);
      }
      const documents = [...(previous?.documents || []).filter(item => item.url !== url), document].slice(-DOMAIN_DOCUMENT_LIMIT);
      const memory: DomainMemory = { ...fields, id: existing?.id || crypto.randomUUID(), scopeValue,
        terms: [...terms.values()].slice(-DOMAIN_TERM_LIMIT), documents, updatedAt: Date.now() };
      await this.storage.set({ domainMemories: [memory, ...memories.filter(item => item.id !== memory.id)].slice(0, DOMAIN_MEMORY_LIMIT) });
      return memory;
    });
  }

  async deleteDomainMemory(id: string): Promise<void> {
    if (!validId(id)) throw new Error('自动领域记忆 ID 无效。');
    await this.mutate(async () => {
      const memories = await this.listDomainMemories();
      await this.storage.set({ domainMemories: memories.filter(memory => memory.id !== id) });
    });
  }

  private async readSessions(): Promise<DocumentSession[]> {
    const { documentSessions } = await this.storage.get('documentSessions');
    if (!Array.isArray(documentSessions)) return [];
    const seen = new Set<string>();
    const ids = new Set<string>();
    return documentSessions.map(storedSession).filter((session): session is DocumentSession => Boolean(session))
      .sort((a, b) => b.updatedAt - a.updatedAt).filter(session => {
        const key = JSON.stringify([session.url, session.identity]);
        if (seen.has(key) || ids.has(session.id)) return false;
        seen.add(key);
        ids.add(session.id);
        return true;
      }).slice(0, SESSION_LIMIT);
  }

  async readSession(url: string, identity: string): Promise<DocumentSession | undefined> {
    const normalizedUrl = documentUrl(url);
    const normalizedIdentity = sessionIdentity(identity);
    return (await this.readSessions()).find(session => session.url === normalizedUrl && session.identity === normalizedIdentity);
  }

  async appendTurn(url: string, identity: string, input: SessionTurn): Promise<void> {
    const normalizedUrl = documentUrl(url);
    const normalizedIdentity = sessionIdentity(identity);
    const turn = cleanTurn(input);
    // Invalid, placeholder-bearing, or oversized turns are omitted as complete pairs.
    if (!turn) return;
    await this.mutate(async () => {
      const sessions = await this.readSessions();
      const existing = sessions.find(session => session.url === normalizedUrl && session.identity === normalizedIdentity);
      const turns = existing?.turns.filter(item => item.source !== turn.source || item.heading !== turn.heading) || [];
      const session: DocumentSession = {
        id: existing?.id || crypto.randomUUID(), url: normalizedUrl, identity: normalizedIdentity,
        turns: [...turns, turn].slice(-TURN_LIMIT), updatedAt: Date.now(),
      };
      const next = [session, ...sessions.filter(item => item.id !== session.id)].slice(0, SESSION_LIMIT);
      await this.storage.set({ documentSessions: next });
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return (await this.readSessions()).map(session => ({ id: session.id, url: session.url, turnCount: session.turns.length, updatedAt: session.updatedAt }));
  }

  async clearSessions(): Promise<void> {
    await this.mutate(() => this.storage.set({ documentSessions: [] }));
  }
}
