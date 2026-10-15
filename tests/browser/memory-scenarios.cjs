const assert = require('node:assert/strict');

/**
 * Memory, session-history, domain-discovery and stored-data scenarios.
 * `order` keeps the position these scenarios held in the original single-session
 * smoke test so their preconditions (earlier translations, rules and memories) hold.
 */
module.exports = [
  {
    order: 5,
    name: 'output-format migration removes legacy JSON cache/history and preserves rules, context and Key',
    async run({ options, api, base, restartExtension }) {
      await options.locator('#memory-scope-value').fill(`${base}/docs/`);
      await options.locator('#memory-domain').fill('QA Agent Context');
      await options.locator('#memory-context').fill('Use the saved document context for agent terminology.');
      await options.locator('#save-memory').click();
      await options.waitForFunction(() => document.querySelector('#memories').textContent.includes('QA Agent Context'));

      const beforeMigration = await api({ type: 'GET_STATE' });
      const keysBeforeMigration = await options.evaluate(() => chrome.storage.session.get('sessionKeys'));
      await options.evaluate(async base => {
        const translation = '{"documentTitle":"02 工具审批 human in loop · Microsoft Agent Framework —— 从入门到进阶","section":"MAF 中的工具审批","text":"MAF 中的工具审批"}';
        await chrome.storage.local.set({ translationFormatVersion: 'legacy-json-v1', documentSessions: [{ id: 'legacy-session', url: `${base}/docs/json-output.html`, identity: 'legacy-identity', turns: [{ source: 'Tool Approval in MAF', translation, heading: '', at: Date.now() }], updatedAt: Date.now() }] });
        await chrome.storage.session.set({ 'cache:legacy-envelope': { text: translation, at: Date.now() }, 'job:legacy-envelope': { seenTerms: [], at: Date.now() } });
      }, base);
      const afterMigration = await restartExtension();
      assert.equal(afterMigration.sessions.length, 0);
      assert.deepEqual(afterMigration.rules, beforeMigration.rules);
      assert.deepEqual(afterMigration.memories, beforeMigration.memories);
      assert.deepEqual(afterMigration.profiles, beforeMigration.profiles);
      assert.deepEqual(await options.evaluate(() => chrome.storage.session.get('sessionKeys')), keysBeforeMigration);
      const migratedStorage = await options.evaluate(async () => ({ local: await chrome.storage.local.get(['documentSessions', 'translationFormatVersion']), session: await chrome.storage.session.get(['cache:legacy-envelope', 'job:legacy-envelope']) }));
      assert.deepEqual(migratedStorage.local.documentSessions, []);
      assert.equal(migratedStorage.local.translationFormatVersion, 'plain-text-v2');
      assert.deepEqual(migratedStorage.session, {});
    },
  },
  {
    order: 8,
    name: 'stored context and Agent history survive worker restart; context change isolates history',
    async run({ api, requests, restartExtension, document }) {
      const documentPage = await document();
      const afterWorkerRestart = await restartExtension();
      assert.equal(afterWorkerRestart.sessions.length, 1);
      assert.equal(afterWorkerRestart.sessions[0].turnCount, 3);
      assert.equal(afterWorkerRestart.memories[0].domain, 'QA Agent Context');
      await documentPage.evaluate(() => {
        const paragraph = document.createElement('p'); paragraph.id = 'after-restart';
        paragraph.textContent = 'After service worker restart, an agent can reuse document context.';
        document.querySelector('article').append(paragraph);
      });
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('#after-restart + .docling-translation')?.dataset.doclingState === 'done');
      assert.ok(requests.at(-1).body.messages.some(message => message.role === 'assistant'));
      const storedMemory = afterWorkerRestart.memories[0];
      await api({ type: 'SAVE_MEMORY', memory: { ...storedMemory, context: 'Changed context starts an isolated Agent history.' } });
      await documentPage.evaluate(() => {
        const paragraph = document.createElement('p'); paragraph.id = 'after-identity-change';
        paragraph.textContent = 'Changing the document context starts a separate agent conversation.';
        document.querySelector('article').append(paragraph);
      });
      const changedContextRequestIndex = requests.length;
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('#after-identity-change + .docling-translation')?.dataset.doclingState === 'done');
      assert.equal(requests[changedContextRequestIndex].body.messages.filter(message => message.role === 'assistant').length, 0);
    },
  },
  {
    order: 14,
    name: 'discovery precedes translation, auto terms persist/reuse, new chapters merge and manual terms win',
    async run({ api, base, requests, analysisRequests, document }) {
      const documentPage = await document();
      await documentPage.goto(`${base}/auto-guide/first.html`);
      await documentPage.bringToFront();
      const manualBeforeDiscovery = (await api({ type: 'GET_STATE' })).memories;
      const autoStartRequestIndex = requests.length;
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('.docling-translation')?.dataset.doclingState === 'done');
      assert.match(requests[autoStartRequestIndex].body.messages[0].content, /DOC_DOMAIN_ANALYSIS_V1/);
      assert.match(await documentPage.locator('.docling-translation').textContent(), /An agent/);
      let discovered = (await api({ type: 'GET_STATE' })).domainMemories.find(memory => memory.scopeValue === `${base}/auto-guide/`);
      assert.ok(discovered.terms.some(term => term.term === 'agent' && term.action === 'keep'));
      assert.deepEqual((await api({ type: 'GET_STATE' })).memories, manualBeforeDiscovery);

      const discoveryCountBeforeReuse = analysisRequests.length;
      await documentPage.reload();
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('.docling-translation')?.dataset.doclingState === 'done');
      assert.equal(analysisRequests.length, discoveryCountBeforeReuse);
      await documentPage.goto(`${base}/auto-guide/next.html`);
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('.docling-translation')?.dataset.doclingState === 'done');
      discovered = (await api({ type: 'GET_STATE' })).domainMemories.find(memory => memory.scopeValue === `${base}/auto-guide/`);
      assert.equal(discovered.documents.length, 2);
      assert.ok(discovered.terms.some(term => term.term === 'workflow'));
      await api({ type: 'SAVE_RULE', rule: { term: 'agent', action: 'translate', translation: '人工智能体', scope: 'collection', scopeValue: `${base}/auto-guide/`, domain: '' } });
      await documentPage.reload();
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('.docling-translation')?.dataset.doclingState === 'done');
      assert.match(await documentPage.locator('.docling-translation').textContent(), /人工智能体/);
    },
  },
  {
    order: 15,
    name: 'manual domain override excludes old-domain automatic terms while keeping manual rules without model calls',
    async run({ api, options, base, requests, document }) {
      const documentPage = await document();
      await documentPage.bringToFront();
      const tabId = await options.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      const settingsBeforeDomainOverride = (await api({ type: 'GET_STATE' })).settings;
      const getTopFrameContext = () => options.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => chrome.runtime.sendMessage({ type: 'GET_CONTEXT' }) }))[0].result, tabId);
      assert.ok((await getTopFrameContext()).rules.some(rule => rule.id.startsWith('auto-')));
      const requestsBeforeDomainOverride = requests.length;
      await api({ type: 'SAVE_SETTINGS', settings: { domain: 'Financial Accounting', context: 'Use accounting terminology for this page.' } });
      const overriddenContext = await getTopFrameContext();
      assert.equal(overriddenContext.ok, true);
      assert.equal(overriddenContext.settings.domain, 'Financial Accounting');
      assert.equal(overriddenContext.settings.context, 'Use accounting terminology for this page.');
      assert.equal(overriddenContext.rules.some(rule => rule.id.startsWith('auto-')), false);
      assert.ok(overriddenContext.rules.some(rule => rule.term === 'agent' && rule.translation === '人工智能体' && !rule.id.startsWith('auto-')));
      await api({ type: 'SAVE_SETTINGS', settings: { domain: settingsBeforeDomainOverride.domain, context: settingsBeforeDomainOverride.context } });
      assert.equal(requests.length, requestsBeforeDomainOverride);
    },
  },
  {
    order: 16,
    name: 'analysis failure falls back to translation; cancellation writes no auto memory or translation',
    async run({ api, base, requests, gate, document }) {
      const documentPage = await document();
      await documentPage.goto(`${base}/auto-failure/first.html`);
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('.docling-translation')?.dataset.doclingState === 'done');
      assert.equal((await api({ type: 'GET_STATE' })).domainMemories.some(memory => memory.scopeValue === `${base}/auto-failure/`), false);
      await documentPage.goto(`${base}/auto-cancel/first.html`);
      const beforeCancelledRequest = requests.length;
      await api({ type: 'START' });
      for (let attempt = 0; !gate.releaseCancelledAnalysis && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(typeof gate.releaseCancelledAnalysis, 'function');
      await api({ type: 'STOP' });
      gate.releaseCancelledAnalysis();
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal((await api({ type: 'GET_STATUS' })).status.running, false);
      assert.equal((await api({ type: 'GET_STATE' })).domainMemories.some(memory => memory.scopeValue === `${base}/auto-cancel/`), false);
      assert.equal(requests.slice(beforeCancelledRequest).some(request => !request.body.messages[0].content.includes('DOC_DOMAIN_ANALYSIS_V1')), false);
      assert.equal(await documentPage.locator('.docling-translation[data-docling-state="done"]').count(), 0);
    },
  },
  {
    order: 17,
    name: 'popup discovery switch works and unedited context is not promoted to manual memory',
    async run({ api, base, analysisRequests, openPopup, document }) {
      const documentPage = await document();
      await documentPage.goto(`${base}/auto-off/first.html`);
      const popup = await openPopup();
      await documentPage.bringToFront();
      await popup.reload();
      await popup.waitForFunction(() => document.querySelector('#profile').options.length > 0);
      const popupManualBefore = (await api({ type: 'GET_STATE' })).memories;
      const beforeDisabledDiscovery = analysisRequests.length;
      await popup.locator('#auto-discover').uncheck();
      await popup.locator('#start').click();
      await documentPage.waitForFunction(() => document.querySelector('.docling-translation')?.dataset.doclingState === 'done');
      assert.equal(analysisRequests.length, beforeDisabledDiscovery);
      assert.equal((await api({ type: 'GET_STATE' })).settings.autoDiscover, false);
      assert.deepEqual((await api({ type: 'GET_STATE' })).memories, popupManualBefore);
      await popup.close();
      await documentPage.bringToFront();
      await api({ type: 'SAVE_SETTINGS', settings: { autoDiscover: true } });
    },
  },
  {
    order: 21,
    name: 'clear recent history removes persisted sessions/cache and preserves explicit memories/rules/Key',
    async run({ api, options }) {
      const beforeClear = await api({ type: 'GET_STATE' });
      assert.ok(beforeClear.sessions.length > 0);
      const backupBeforeClear = (await api({ type: 'EXPORT_CONFIG' })).config;
      assert.equal(Object.hasOwn(backupBeforeClear, 'sessions'), false);
      assert.equal(Object.hasOwn(backupBeforeClear, 'documentSessions'), false);
      assert.ok(backupBeforeClear.memories.length > 0);
      await options.reload();
      await options.locator('details').filter({ has: options.locator('#clear-sessions') }).locator('summary').click();
      await options.locator('#clear-sessions').click();
      await options.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATE' })).sessions.length === 0);
      const afterClear = await api({ type: 'GET_STATE' });
      assert.equal(afterClear.memories.length, beforeClear.memories.length);
      assert.equal(afterClear.rules.length, beforeClear.rules.length);
      assert.equal(afterClear.profiles[0].hasKey, true);
      assert.equal(await options.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).some(key => key.startsWith('cache:'))), false);
    },
  },
];
