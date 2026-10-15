const assert = require('node:assert/strict');

/**
 * In-page reading UI scenarios: bilingual DOM, display modes, selection menu,
 * skipped paragraphs, resume/undo, teardown, output envelopes and safety.
 * `order` keeps the position these scenarios held in the original single-session
 * smoke test so their preconditions hold.
 */
module.exports = [
  {
    order: 6,
    name: 'bilingual DOM, inline code/links, translate=no, first-use rule, 429 retry',
    async run({ api, options, base, requests, document, inShadow, clickShadowButton }) {
      const documentPage = await document();
      await documentPage.goto(`${base}/docs/observability.html`);
      const originalCode = await documentPage.locator('#sample-code').textContent();
      await documentPage.bringToFront();
      const firstPageRequestIndex = requests.length;
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelectorAll('.docling-translation[data-docling-state="done"]').length >= 8);
      await documentPage.waitForFunction(() => document.querySelectorAll('.docling-translation[data-docling-state="pending"]').length === 0);
      assert.equal(await documentPage.locator('.docling-translation[data-docling-state="error"]').count(), 1);
      assert.equal(await documentPage.locator('#sample-code').textContent(), originalCode);
      assert.equal(await documentPage.locator('#paragraph-code a').getAttribute('href'), 'https://example.com/docs/tracing');
      assert.equal(await documentPage.locator('#untranslatable').getAttribute('data-docling-source'), null);
      assert.equal(await documentPage.locator('textarea').inputValue(), 'Never translate text entered here.');
      assert.match(requests[firstPageRequestIndex].body.messages[0].content, /DOC_DOMAIN_ANALYSIS_V1/);
      assert.match(await documentPage.locator('#paragraph-agent + .docling-translation').textContent(), /An agent/);
      assert.match(await documentPage.locator('#paragraph-code + .docling-translation').textContent(), /ActivitySource/);
      assert.match(await documentPage.locator('#paragraph-agent + .docling-translation').textContent(), /会话（session）/);
      assert.equal(await documentPage.locator('.docling-translation').evaluateAll(nodes => nodes.filter(node => node.textContent.includes('会话（session）')).length), 1);
      await documentPage.getByRole('button', { name: '重试本段', exact: true }).click();
      await documentPage.waitForFunction(() => document.querySelector('#paragraph-skip + .docling-translation')?.dataset.doclingState === 'done');
      assert.match(requests.at(-1).body.messages[0].content, /QA Agent Context/);
      assert.ok(requests.at(-1).body.messages.some(message => message.role === 'assistant'));
      const sessionsBeforeRestart = await options.evaluate(async () => (await chrome.storage.local.get('documentSessions')).documentSessions);
      assert.equal(sessionsBeforeRestart.length, 1);
      assert.equal(sessionsBeforeRestart[0].turns.length, 3);
      assert.doesNotMatch(JSON.stringify(sessionsBeforeRestart), /\[\[(DTR|DOC_CODE)_|qa-test-not-a-real-key/);
    },
  },
  {
    order: 7,
    name: 'display mode switches do not call provider',
    async run({ api, requests, document }) {
      const documentPage = await document();
      const requestCount = requests.length;
      await api({ type: 'SET_MODE', mode: 'translation' });
      await documentPage.waitForFunction(() => getComputedStyle(document.querySelector('#paragraph-agent')).display === 'none');
      await api({ type: 'SET_MODE', mode: 'source' });
      await documentPage.waitForFunction(() => getComputedStyle(document.querySelector('.docling-translation')).display === 'none');
      await api({ type: 'SET_MODE', mode: 'dual' });
      await documentPage.waitForFunction(() => getComputedStyle(document.querySelector('#paragraph-agent')).display !== 'none');
      assert.equal(requests.length, requestCount);
    },
  },
  {
    order: 9,
    name: 'content cannot read profiles/key storage; scoped context available',
    async run({ options, document }) {
      await document();
      const tabId = await options.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      const contentAccess = await options.evaluate(async id => (await chrome.scripting.executeScript({ target: { tabId: id }, func: async () => {
        const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
        const context = await chrome.runtime.sendMessage({ type: 'GET_CONTEXT' });
        let storageDenied = false;
        try { await chrome.storage.local.get(null); } catch { storageDenied = true; }
        return { state, context, storageDenied };
      } }))[0].result, tabId);
      assert.equal(contentAccess.state.ok, false);
      assert.equal(contentAccess.context.ok, true);
      assert.equal(JSON.stringify(contentAccess).includes('qa-test-not-a-real-key'), false);
      assert.equal(contentAccess.storageDenied, true);
    },
  },
  {
    order: 10,
    name: 'select agent, save collection rule, refresh old translations',
    async run({ api, document, inShadow, clickShadowButton }) {
      const documentPage = await document();
      await documentPage.locator('#paragraph-agent').scrollIntoViewIfNeeded();
      await documentPage.evaluate(() => {
        const node = document.querySelector('#paragraph-agent').firstChild;
        const start = node.textContent.indexOf('agent');
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 5);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      });
      await new Promise(resolve => setTimeout(resolve, 120));
      assert.equal(await inShadow(documentPage, 'return this.querySelector("#docling-term-scope").value;'), 'collection');
      await clickShadowButton(documentPage, '保存规则');
      await documentPage.waitForFunction(() => document.querySelectorAll('[data-docling-state="stale"]').length > 0);
      await clickShadowButton(documentPage, '更新译文');
      await documentPage.waitForFunction(() => document.querySelector('#paragraph-agent + .docling-translation')?.dataset.doclingState === 'done' && document.querySelector('#paragraph-agent + .docling-translation')?.textContent.includes('An agent'));
      await documentPage.waitForFunction(() => document.querySelectorAll('.docling-translation[data-docling-state="pending"]').length === 0);
      assert.match(await documentPage.locator('#paragraph-agent + .docling-translation').textContent(), /An agent/);
      assert.equal((await api({ type: 'GET_STATE' })).rules.find(rule => rule.term === 'agent').scope, 'collection');
    },
  },
  {
    order: 11,
    name: 'persisted paragraph skip and agent preference after page reload',
    async run({ api, document }) {
      const documentPage = await document();
      const skipTranslation = documentPage.locator('#paragraph-skip + .docling-translation');
      await skipTranslation.getByRole('button', { name: '不翻译这段', exact: true }).click();
      await documentPage.waitForFunction(() => !document.querySelector('#paragraph-skip').nextElementSibling?.classList.contains('docling-translation'));
      assert.equal((await api({ type: 'GET_STATE' })).skips.length, 1);
      await documentPage.reload();
      await documentPage.bringToFront();
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('#paragraph-agent + .docling-translation')?.dataset.doclingState === 'done');
      await documentPage.waitForFunction(() => document.querySelectorAll('.docling-translation[data-docling-state="pending"]').length === 0);
      assert.equal(await documentPage.locator('#paragraph-skip').getAttribute('data-docling-source'), null);
      assert.match(await documentPage.locator('#paragraph-agent + .docling-translation').textContent(), /An agent/);
    },
  },
  {
    order: 12,
    name: 'resume avoids duplicate output; undo restores overwritten rule',
    async run({ api, options, document, inShadow, clickShadowButton }) {
      const documentPage = await document();
      const translationsBeforeResume = await documentPage.locator('.docling-translation').count();
      await api({ type: 'START' });
      assert.equal(await documentPage.locator('.docling-translation').count(), translationsBeforeResume);
      await documentPage.locator('#paragraph-agent').scrollIntoViewIfNeeded();
      await documentPage.evaluate(() => {
        const node = document.querySelector('#paragraph-agent').firstChild;
        const start = node.textContent.indexOf('agent');
        const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 5);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      });
      await new Promise(resolve => setTimeout(resolve, 120));
      await inShadow(documentPage, 'const action = this.querySelector("#docling-term-action"); action.value = "translate"; action.dispatchEvent(new Event("change")); this.querySelector("#docling-term-translation").value = "临时译名";');
      await clickShadowButton(documentPage, '保存规则');
      await options.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATE' })).rules.find(rule => rule.term === 'agent')?.translation === '临时译名');
      await clickShadowButton(documentPage, '撤销');
      await options.waitForFunction(async () => (await chrome.runtime.sendMessage({ type: 'GET_STATE' })).rules.find(rule => rule.term === 'agent')?.action === 'keep');
      await clickShadowButton(documentPage, '更新译文');
      await documentPage.waitForFunction(() => document.querySelector('#paragraph-agent + .docling-translation')?.dataset.doclingState === 'done');
      await documentPage.waitForFunction(() => document.querySelectorAll('.docling-translation[data-docling-state="pending"]').length === 0);
    },
  },
  {
    order: 13,
    name: 'close restores original paragraphs, list and table structure',
    async run({ options, document, clickShadowButton, screenshot }) {
      const documentPage = await document();
      await screenshot(documentPage, 'bilingual-document.png');
      await screenshot(options, 'settings.png');
      await clickShadowButton(documentPage, '×');
      assert.equal(await documentPage.locator('.docling-translation, [data-docling-source], [data-docling-wrapper], [data-docling-ui]').count(), 0);
      assert.equal(await documentPage.locator('table tbody tr td').first().textContent(), 'Trace');
      assert.equal(await documentPage.locator('li').first().textContent(), 'Keep agent instructions clear and test tool failures.');
    },
  },
  {
    order: 18,
    name: 'JSON/fenced envelopes unwrap before display/history; tokens and genuine JSON examples remain intact',
    async run({ api, options, base, requests, document, screenshot }) {
      const documentPage = await document();
      await documentPage.goto(`${base}/docs/json-output.html`);
      await documentPage.bringToFront();
      const requestsBeforeEnvelope = requests.length;
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelectorAll('.docling-translation[data-docling-state="done"]').length === 3 && document.querySelectorAll('.docling-translation[data-docling-state="error"]').length === 1);
      const jsonTranslation = documentPage.locator('#envelope-json + .docling-translation');
      assert.match(await jsonTranslation.textContent(), /正文译文：agent RunAsync\(\)/);
      assert.equal(await jsonTranslation.locator('code').textContent(), 'RunAsync()');
      assert.doesNotMatch(await jsonTranslation.textContent(), /documentTitle|section|MODEL_ENVELOPE_METADATA_NOT_VISIBLE|\[\[(?:DTR|DOC_CODE)_/);
      assert.match(await documentPage.locator('#envelope-fence + .docling-translation').textContent(), /围栏译文：agent/);
      assert.doesNotMatch(await documentPage.locator('#envelope-fence + .docling-translation').textContent(), /```|documentTitle/);
      assert.match(await documentPage.locator('#genuine-json + .docling-translation').textContent(), /\{"documentTitle":"示例","section":"样本","text":"你好"\}/);
      assert.equal(await documentPage.locator('#invalid-envelope + .docling-translation').getByRole('button', { name: '重试本段', exact: true }).count(), 1);
      const envelopeRequests = requests.slice(requestsBeforeEnvelope);
      assert.ok(envelopeRequests.find(request => !request.body.messages[0].content.includes('DOC_DOMAIN_ANALYSIS_V1')).body.messages.at(-1).content.startsWith('Envelope JSON'));
      assert.doesNotMatch(JSON.stringify(envelopeRequests.map(request => request.body.messages)), /MODEL_ENVELOPE_METADATA_NOT_VISIBLE/);
      const envelopeSession = await options.evaluate(async base => (await chrome.storage.local.get('documentSessions')).documentSessions.find(session => session.url === `${base}/docs/json-output.html`), base);
      assert.equal(envelopeSession.turns.length, 3);
      assert.doesNotMatch(JSON.stringify(envelopeSession.turns), /MODEL_ENVELOPE_METADATA_NOT_VISIBLE|Invalid envelope|\[\[(?:DTR|DOC_CODE)_/);
      await screenshot(documentPage, 'json-output-fixed.png');
    },
  },
  {
    order: 19,
    name: 'model-provided HTML renders as inert text',
    async run({ api, base, document }) {
      const documentPage = await document();
      await documentPage.goto(`${base}/docs/security.html`);
      await documentPage.bringToFront();
      await api({ type: 'START' });
      await documentPage.waitForFunction(() => document.querySelector('.docling-translation')?.dataset.doclingState === 'done');
      assert.equal(await documentPage.locator('.docling-translation img').count(), 0);
      assert.equal(await documentPage.evaluate(() => globalThis.__modelInjected === true), false);
      assert.match(await documentPage.locator('.docling-translation').textContent(), /<img src=x/);
    },
  },
  {
    order: 20,
    name: 'immediate stop clears running state and keeps source readable',
    async run({ api, base, document }) {
      const documentPage = await document();
      await documentPage.goto(`${base}/docs/cancel.html`);
      await documentPage.bringToFront();
      await api({ type: 'START' });
      await api({ type: 'STOP' });
      await documentPage.waitForFunction(() => !document.querySelector('.docling-translation')?.textContent.includes('正在翻译'));
      assert.equal((await api({ type: 'GET_STATUS' })).status.running, false);
      assert.equal(await documentPage.locator('main p').isVisible(), true);
    },
  },
];
