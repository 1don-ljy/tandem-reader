const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../src/memory/repository.ts');

function storage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const result = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) result[key] = structuredClone(data[key]);
      return result;
    },
    async set(items) { Object.assign(data, structuredClone(items)); },
  };
}

const memory = (scope = 'collection', scopeValue = 'https://docs.example.com/guide/') => ({ scope, scopeValue, domain: 'AI Agent', context: 'Agent 指可调用工具的智能体。' });
const turn = (number) => ({ source: `Source ${number}`, translation: `译文 ${number}`, heading: 'Testing', at: number });
const domainTerm = (term = 'agent', extra = {}) => ({ term, translation: '智能体', meaning: '可调用工具完成任务的模型执行实体。', action: 'keep', evidence: 'An agent can call tools.', ...extra });
const analysis = (extra = {}) => ({ url: 'https://docs.example.com/guide/intro.html', fingerprint: 'a'.repeat(64), domain: 'AI Agent', context: '技术文档讨论智能体与工具调用。', terms: [domainTerm()], ...extra });

test('document context persists independently of the repository instance and resolves narrowest scope', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage();
  const repository = new MemoryRepository(port);
  const root = await repository.saveMemory(memory());
  const nested = await repository.saveMemory(memory('collection', 'https://docs.example.com/guide/testing/'));
  const page = await repository.saveMemory(memory('page', 'https://docs.example.com/guide/testing/a.html#trace'));
  const restored = new MemoryRepository(port);
  assert.equal((await restored.findMemory('https://docs.example.com/guide/testing/a.html#different')).id, page.id);
  assert.equal((await restored.findMemory('https://docs.example.com/guide/testing/b.html')).id, nested.id);
  assert.equal((await restored.findMemory('https://docs.example.com/guide/intro.html')).id, root.id);
  assert.equal(await restored.findMemory('https://docs.example.com/guide-other/intro.html'), undefined);
  assert.equal(await restored.findMemory('https://other.example.com/guide/intro.html'), undefined);
});

test('saving same scope updates one record and explicit edit cannot overwrite another scope record', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  const first = await repository.saveMemory(memory());
  const second = await repository.saveMemory({ ...memory(), context: 'Updated context' });
  assert.equal(second.id, first.id);
  assert.equal((await repository.listMemories()).length, 1);
  const other = await repository.saveMemory(memory('page', 'https://docs.example.com/guide/a.html'));
  await assert.rejects(repository.saveMemory({ ...memory(), id: other.id }), /已有/);
  await repository.deleteMemory(first.id);
  assert.equal((await repository.listMemories()).length, 1);
});

test('concurrent saves are serialized and one failed write does not poison the queue', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage();
  const repository = new MemoryRepository(port);
  await Promise.all(Array.from({ length: 20 }, (_, i) => repository.saveMemory(memory('page', `https://docs.example.com/${i}`))));
  assert.equal((await repository.listMemories()).length, 20);
  const set = port.set;
  port.set = async () => { port.set = set; throw new Error('storage full'); };
  await assert.rejects(repository.saveMemory(memory('page', 'https://docs.example.com/failed')), /storage full/);
  await repository.saveMemory(memory('page', 'https://docs.example.com/recovered'));
  assert.equal((await repository.listMemories()).length, 21);
});

test('stored malformed memory and unexpected secret metadata are never surfaced', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage({ documentMemories: [null, 123, { ...memory(), id: 'ok', updatedAt: 1, apiKey: 'secret' },
    { ...memory(), id: 'bad', scope: ['page'], updatedAt: 2 }, { ...memory(), id: 'bad-url', scopeValue: 'javascript:alert(1)', updatedAt: 3 }] });
  const result = await new MemoryRepository(port).listMemories();
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'ok');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('memory imports validate before replacement and enforce record limits', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  const saved = await repository.saveMemory(memory());
  await assert.rejects(repository.replaceMemories([{ ...saved, context: 'x'.repeat(3001) }]), /无效/);
  assert.deepEqual(await repository.listMemories(), [saved]);
  await assert.rejects(repository.replaceMemories([saved, saved]), /重复/);
  await assert.rejects(repository.saveMemory({ ...memory(), scopeValue: 'https://user:secret@example.com/docs/' }), /账号密码/);
  const hundred = Array.from({ length: 100 }, (_, i) => ({ ...memory('page', `https://docs.example.com/${i}`), id: `memory-${i}`, updatedAt: i }));
  await repository.replaceMemories(hundred);
  await assert.rejects(repository.saveMemory(memory('page', 'https://docs.example.com/overflow')), /100/);
});

test('session retrieval requires the same page and identity and survives repository recreation', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage();
  const repository = new MemoryRepository(port);
  await repository.appendTurn('https://docs.example.com/guide/a.html#section', 'profile-model-domain-revision-1', turn(1));
  const restored = new MemoryRepository(port);
  assert.equal((await restored.readSession('https://docs.example.com/guide/a.html', 'profile-model-domain-revision-1')).turns.length, 1);
  assert.equal(await restored.readSession('https://docs.example.com/guide/a.html', 'profile-model-domain-revision-2'), undefined);
  assert.equal(await restored.readSession('https://docs.example.com/guide/b.html', 'profile-model-domain-revision-1'), undefined);
});

test('sessions retain three complete recent pairs and replace retranslated paragraphs', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  const url = 'https://docs.example.com/a.html';
  for (let i = 1; i <= 5; i++) await repository.appendTurn(url, 'identity', turn(i));
  assert.deepEqual((await repository.readSession(url, 'identity')).turns.map(item => item.source), ['Source 3', 'Source 4', 'Source 5']);
  await repository.appendTurn(url, 'identity', { ...turn(4), translation: '修正后的译文' });
  const turns = (await repository.readSession(url, 'identity')).turns;
  assert.deepEqual(turns.map(item => item.source), ['Source 3', 'Source 5', 'Source 4']);
  assert.equal(turns.at(-1).translation, '修正后的译文');
});

test('unfinished, oversized, or placeholder-bearing pairs are omitted rather than polluting memory', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  const url = 'https://docs.example.com/a.html';
  for (const input of [
    { ...turn(1), translation: '' }, { ...turn(1), source: 'x'.repeat(4001) },
    { ...turn(1), source: '[[DTR_old_0]] uses tools' },
    { ...turn(1), translation: '保留 [[DOC_CODE_0]]' },
    { ...turn(1), heading: '[[DTR_old_0]]' }, { source: 'source' }
  ]) await repository.appendTurn(url, 'identity', input);
  assert.equal(await repository.readSession(url, 'identity'), undefined);
  await repository.appendTurn(url, 'identity', turn(2));
  assert.equal((await repository.readSession(url, 'identity')).turns.length, 1);
});

test('session listing reveals metadata only, bounds pages and clearing does not delete preferences', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage({ rules: [{ term: 'agent' }], localKeys: { existing: 'keep-key' } });
  const repository = new MemoryRepository(port);
  await repository.saveMemory(memory());
  for (let i = 0; i < 35; i++) await repository.appendTurn(`https://docs.example.com/${i}`, 'identity', turn(i));
  const sessions = await repository.listSessions();
  assert.equal(sessions.length, 30);
  assert.equal(await repository.readSession('https://docs.example.com/0', 'identity'), undefined);
  assert.equal(JSON.stringify(sessions).includes('Source'), false);
  assert.equal(JSON.stringify(sessions).includes('identity'), false);
  await repository.clearSessions();
  assert.equal((await repository.listSessions()).length, 0);
  assert.equal((await repository.listMemories()).length, 1);
  assert.deepEqual(port.data.rules, [{ term: 'agent' }]);
  assert.equal(port.data.localKeys.existing, 'keep-key');
});

test('automatic domain memory persists separately and resolves exact origin and longest collection path', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage({ rules: [{ term: 'agent', action: 'translate' }], localKeys: { profile: 'keep-key' } });
  const repository = new MemoryRepository(port);
  const manual = await repository.saveMemory(memory());
  const root = await repository.saveDomainAnalysis(analysis());
  const nested = await repository.saveDomainAnalysis(analysis({ url: 'https://docs.example.com/guide/testing/a.html' }));
  const restored = new MemoryRepository(port);
  assert.equal((await restored.findDomainMemory('https://docs.example.com/guide/testing/b.html#chapter')).id, nested.id);
  assert.equal((await restored.findDomainMemory('https://docs.example.com/guide/other.html')).id, root.id);
  assert.equal(await restored.findDomainMemory('https://docs.example.com/guide-other/a.html'), undefined);
  assert.equal(await restored.findDomainMemory('https://other.example.com/guide/a.html'), undefined);
  assert.deepEqual(await restored.listMemories(), [manual]);
  assert.deepEqual(port.data.rules, [{ term: 'agent', action: 'translate' }]);
  assert.equal(port.data.localKeys.profile, 'keep-key');
});

test('same-domain analyses merge terms case-insensitively and replace the latest document fingerprint', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  const first = await repository.saveDomainAnalysis(analysis());
  await repository.saveDomainAnalysis(analysis({ url: 'https://docs.example.com/guide/next.html', terms: [domainTerm('trace')] }));
  const updated = await repository.saveDomainAnalysis(analysis({ domain: ' ai   agent ', fingerprint: 'B'.repeat(64), terms: [domainTerm('Agent', { action: 'first', translation: '模型智能体' })] }));
  assert.equal(updated.id, first.id);
  assert.deepEqual(updated.terms.map(term => term.term), ['trace', 'Agent']);
  assert.equal(updated.terms.at(-1).translation, '模型智能体');
  assert.equal(updated.documents.length, 2);
  assert.equal(updated.documents.at(-1).fingerprint, 'b'.repeat(64));
  assert.equal((await repository.listDomainMemories()).length, 1);
});

test('changed domain resets prior automatic terms and document fingerprints', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  const previous = await repository.saveDomainAnalysis(analysis());
  const next = await repository.saveDomainAnalysis(analysis({ url: 'https://docs.example.com/guide/finance.html', domain: 'Finance', context: 'Financial reporting terminology.', terms: [domainTerm('margin')] }));
  assert.equal(next.id, previous.id);
  assert.deepEqual(next.terms.map(term => term.term), ['margin']);
  assert.deepEqual(next.documents.map(document => document.url), ['https://docs.example.com/guide/finance.html']);
});

test('automatic-memory writes serialize and retain the latest bounded terms and fingerprints', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  await repository.saveDomainAnalysis(analysis({ terms: Array.from({ length: 80 }, (_, i) => domainTerm(`term-${i}`)) }));
  await Promise.all(Array.from({ length: 21 }, (_, i) => repository.saveDomainAnalysis(analysis({ url: `https://docs.example.com/guide/${i}.html`, fingerprint: i.toString(16).padStart(64, '0'), terms: [domainTerm(`new-${i}`)] }))));
  const result = await repository.findDomainMemory('https://docs.example.com/guide/0.html');
  assert.equal(result.terms.length, 80);
  assert.equal(result.documents.length, 20);
  assert.equal(result.terms.some(term => term.term === 'term-0'), false);
  assert.equal(result.terms.at(-1).term, 'new-20');
  assert.equal(result.documents[0].url, 'https://docs.example.com/guide/1.html');
});

test('automatic-memory runtime validation rejects malformed values without mutating good records', async () => {
  const { MemoryRepository } = await modulePromise;
  const repository = new MemoryRepository(storage());
  const saved = await repository.saveDomainAnalysis(analysis());
  for (const input of [
    analysis({ url: 'https://user:secret@docs.example.com/guide/a.html' }),
    analysis({ fingerprint: 'not-a-hash' }), analysis({ domain: 'x'.repeat(101) }),
    analysis({ context: 'x'.repeat(3001) }), analysis({ context: '[[DTR_private_0]]' }),
    analysis({ terms: [domainTerm('x'.repeat(121))] }),
    analysis({ terms: [domainTerm('agent', { action: ['keep'] })] }),
    analysis({ terms: [domainTerm('agent', { action: 'first', translation: '' })] }),
    analysis({ terms: [domainTerm('agent', { translation: 'x'.repeat(301) })] }),
    analysis({ terms: [domainTerm('agent', { meaning: 'x'.repeat(501) })] }),
    analysis({ terms: [domainTerm('agent', { evidence: 'x'.repeat(301) })] }),
    analysis({ terms: [domainTerm('agent', { meaning: '\u0000' })] }),
    analysis({ terms: Array.from({ length: 81 }, (_, i) => domainTerm(`term-${i}`)) })
  ]) await assert.rejects(repository.saveDomainAnalysis(input));
  assert.deepEqual(await repository.listDomainMemories(), [saved]);
});

test('stored automatic memories strip unknown metadata and discard cross-scope documents or malformed records', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage();
  const repository = new MemoryRepository(port);
  const saved = await repository.saveDomainAnalysis(analysis());
  const withUnknown = { ...saved, apiKey: 'secret-field', terms: saved.terms.map(term => ({ ...term, token: 'secret-term' })) };
  port.data.domainMemories = [null, withUnknown, { ...saved, id: 'cross-scope', documents: [{ url: 'https://evil.example/guide/a.html', fingerprint: 'a'.repeat(64) }] }, { ...saved, id: 'bad-array', terms: 'agent' }];
  assert.deepEqual(await repository.listDomainMemories(), [saved]);
  assert.equal(JSON.stringify(await repository.listDomainMemories()).includes('secret'), false);
});

test('automatic-memory eviction and deletion preserve manual memories, rules and recent sessions', async () => {
  const { MemoryRepository } = await modulePromise;
  const port = storage({ rules: [{ term: 'agent' }] });
  const repository = new MemoryRepository(port);
  await repository.saveMemory(memory());
  await repository.appendTurn('https://docs.example.com/guide/a.html', 'identity', turn(1));
  for (let i = 0; i < 51; i++) await repository.saveDomainAnalysis(analysis({ url: `https://docs.example.com/collection-${i}/a.html` }));
  const memories = await repository.listDomainMemories();
  assert.equal(memories.length, 50);
  assert.equal(await repository.findDomainMemory('https://docs.example.com/collection-0/b.html'), undefined);
  await repository.deleteDomainMemory(memories[0].id);
  assert.equal((await repository.listDomainMemories()).length, 49);
  assert.equal((await repository.listMemories()).length, 1);
  assert.equal((await repository.listSessions()).length, 1);
  assert.deepEqual(port.data.rules, [{ term: 'agent' }]);
});
