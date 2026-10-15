const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const ARTIFACTS = path.join(ROOT, 'tests', 'artifacts');

/**
 * Starts the local mock model and fixture server.
 *
 * `routes` is a list of `{ method?, match, handle }`. `match` accepts an exact
 * path, a RegExp or a predicate. `handle(context)` receives
 * `{ request, url, method, body, headers }` and returns
 * `{ status?, type?, body }`; an object body is serialised as JSON. Returning
 * nothing falls through to the next route.
 */
async function startMockModel(routes) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    if (request.method === 'POST') for await (const chunk of request) chunks.push(chunk);
    const context = {
      request,
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
    };
    for (const route of routes) {
      if (route.method && route.method !== request.method) continue;
      const matched = typeof route.match === 'string'
        ? route.match === request.url
        : route.match instanceof RegExp ? route.match.test(request.url) : route.match(request.url);
      if (!matched) continue;
      const reply = await route.handle(context);
      if (!reply) continue;
      response.writeHead(reply.status ?? 200, { 'Content-Type': reply.type ?? 'application/json' });
      response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      return;
    }
    response.writeHead(404); response.end('not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    server,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function html(body) {
  return { type: 'text/html; charset=utf-8', body };
}

/**
 * The project's mock model routes: a Chat Completions endpoint plus the fixture
 * pages the scenarios navigate to. `record` collects every request and `gate`
 * lets a scenario hold one analysis request open.
 */
function modelRoutes({ record, fixture, jsonFixture, gate }) {
  const autoPages = {
    '/auto-guide/first.html': 'An agent can call tools in AUTO_DISCOVERY_FIRST.',
    '/auto-guide/next.html': 'A workflow coordinates agent tools in AUTO_DISCOVERY_NEXT.',
    '/auto-failure/first.html': 'An agent continues reading after AUTO_ANALYSIS_FAILURE.',
    '/auto-cancel/first.html': 'An agent is waiting for AUTO_ANALYSIS_CANCEL.',
    '/auto-off/first.html': 'An agent should not trigger discovery in AUTO_DISCOVERY_OFF.',
  };
  return [
    {
      method: 'POST',
      match: '/v1/chat/completions',
      handle({ body, headers }) {
        record.requests.push({ body, authorization: headers.authorization });
        const source = body.messages.at(-1).content;
        if (body.messages[0].content.includes('DOC_DOMAIN_ANALYSIS_V1')) {
          record.analysisRequests.push({ body, source });
          if (source.includes('AUTO_ANALYSIS_FAILURE')) {
            return { status: 503, body: { error: 'simulated analysis failure' } };
          }
          if (source.includes('AUTO_ANALYSIS_CANCEL')) {
            return gate.holdCancelledAnalysis().then(() => ({
              body: { choices: [{ message: { content: JSON.stringify({ domain: 'AI Agent', context: 'Released after cancellation.', terms: [] }) }, finish_reason: 'stop' }] },
            }));
          }
          const terms = ['agent', 'session', 'workflow'].flatMap(term => {
            const index = source.toLowerCase().indexOf(term);
            if (index < 0) return [];
            return [{ term, translation: term === 'session' ? '自动会话' : '', action: term === 'session' ? 'translate' : 'keep', meaning: `${term} 是本文技术语境中的概念。`, evidence: source.slice(index, index + 100).replace(/\s+/g, ' ').trim() }];
          });
          return { body: { choices: [{ message: { content: JSON.stringify({ domain: 'AI Agent', context: 'Agents use tools in these technical documents.', terms }) }, finish_reason: 'stop' }] } };
        }
        let explanation;
        if (body.messages[0].content.includes('简短解释技术术语')) explanation = JSON.parse(source);
        if (source.startsWith('This paragraph is intentionally') && !gate.failedParagraph) {
          gate.failedParagraph = true;
          return { status: 429, body: { error: 'simulated rate limit' } };
        }
        let content = source === 'Model markup safety check.'
          ? '<img src=x onerror="globalThis.__modelInjected=true">安全检查'
          : explanation?.term ? '模拟解释：agent 在这里表示能够调用工具的智能体。'
            : source === 'OK' ? 'OK' : `模拟译文：${source.replace(/\bagent\b/gi, '代理')}`;
        if (source.startsWith('Envelope JSON') || source.startsWith('Envelope fence')) {
          const tokens = source.match(/\[\[(?:DTR_[^\]]+|DOC_CODE_\d+)\]\]/g) || [];
          content = JSON.stringify({ documentTitle: 'MODEL_ENVELOPE_METADATA_NOT_VISIBLE', section: 'Metadata only', text: `${source.startsWith('Envelope JSON') ? '正文译文' : '围栏译文'}：${tokens.join(' ')}。` });
          if (source.startsWith('Envelope fence')) content = `\`\`\`json\n${content}\n\`\`\``;
        } else if (source === '{"documentTitle":"Example","section":"Sample","text":"Hello"}') {
          content = '{"documentTitle":"示例","section":"样本","text":"你好"}';
        } else if (source.startsWith('Invalid envelope')) {
          content = '{"documentTitle":"Invalid envelope","text":""}';
        }
        return { body: { choices: [{ message: { content }, finish_reason: 'stop' }] } };
      },
    },
    {
      match: url => Object.hasOwn(autoPages, url),
      handle({ url }) {
        return html(`<html><head><title>Automatic Domain Test</title></head><body><main><p id="auto-paragraph">${autoPages[url]}</p></main></body></html>`);
      },
    },
    { match: '/docs/json-output.html', handle: () => html(jsonFixture) },
    {
      match: url => url === '/docs/security.html' || url === '/docs/cancel.html',
      handle({ url }) {
        return html(`<html><body><main><p>${url.includes('security') ? 'Model markup safety check.' : 'Cancel this fresh translation before it finishes.'}</p></main></body></html>`);
      },
    },
    { match: url => url === '/docs/observability.html' || url === '/docs/next.html', handle: () => html(fixture) },
  ];
}

/** Launches the extension once and hands the session to `subject`. */
async function withExtension(subject) {
  const session = await openSession();
  try {
    return await subject(session);
  } finally {
    await session.close();
  }
}

async function openSession() {
  let playwright;
  try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { throw new Error('Set PLAYWRIGHT_MODULE to an installed playwright package directory before running this optional test.'); }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'docling-qa-'));
  const extensionPath = path.join(scratch, 'extension');
  await fs.cp(path.join(ROOT, 'extension'), extensionPath, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
  // The isolated test copy grants the local mock and intercepted preset origins. Real installation uses
  // activeTab + a native optional-host prompt, which this headless test cannot exercise.
  manifest.host_permissions = ['http://127.0.0.1/*', 'https://api.deepseek.com/*', 'https://open.bigmodel.cn/*'];
  await fs.writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
  const fixture = await fs.readFile(path.join(FIXTURES, 'technical-document.html'));
  const jsonFixture = await fs.readFile(path.join(FIXTURES, 'json-output.html'));

  const record = { requests: [], analysisRequests: [], presetRequests: [], issues: [] };
  const gate = {
    failedParagraph: false,
    /** Resolved by the route when the held analysis request arrives; scenarios call it to release. */
    releaseCancelledAnalysis: undefined,
    holdCancelledAnalysis: () => new Promise(resolve => { gate.releaseCancelledAnalysis = resolve; }),
  };
  const model = await startMockModel(modelRoutes({ record, fixture, jsonFixture, gate }));

  let context;
  try {
    context = await playwright.chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      channel: 'chromium', headless: true, viewport: { width: 1440, height: 1100 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-proxy-server', '--host-resolver-rules=MAP api.deepseek.com ~NOTFOUND, MAP open.bigmodel.cn ~NOTFOUND']
    });
    // DNS is also blocked for these domains: an interception failure must never
    // fall through to a real provider. Only dummy credentials are used below.
    await context.route('https://**/*', async route => {
      const request = route.request();
      if (request.method() !== 'POST' || !['https://api.deepseek.com/chat/completions', 'https://open.bigmodel.cn/api/paas/v4/chat/completions'].includes(request.url())) {
        record.issues.push(`Unexpected external request: ${request.url()}`);
        await route.abort();
        return;
      }
      record.presetRequests.push({ url: request.url(), body: request.postDataJSON(), authorization: request.headers().authorization });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }) });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    const cdpSessions = new WeakMap();
    async function cdp(page) {
      let session = cdpSessions.get(page);
      if (!session) {
        session = await context.newCDPSession(page);
        cdpSessions.set(page, session);
      }
      return session;
    }
    let sharedDocumentPage;
    async function document() {
      if (!sharedDocumentPage) sharedDocumentPage = await newPage();
      return sharedDocumentPage;
    }
    function newPage() {
      const page = context.newPage();
      return page.then(async opened => { opened.on('pageerror', error => record.issues.push(error.message)); return opened; });
    }
    async function api(message) {
      const result = await options.evaluate(value => chrome.runtime.sendMessage(value), message);
      assert.equal(result.ok, true, result.error);
      return result;
    }
    async function restartExtension() {
      const cdpSession = await cdp(options);
      let versions = [];
      cdpSession.on('ServiceWorker.workerVersionUpdated', event => { versions = event.versions; });
      await cdpSession.send('ServiceWorker.enable');
      for (let attempt = 0; !versions.some(version => version.scriptURL === worker.url()) && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const version = versions.find(item => item.scriptURL === worker.url());
      assert.ok(version, 'Expected the extension service worker version');
      await cdpSession.send('ServiceWorker.stopWorker', { versionId: version.versionId });
      for (let attempt = 0; !versions.some(item => item.versionId === version.versionId && item.runningStatus === 'stopped') && attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(versions.some(item => item.versionId === version.versionId && item.runningStatus === 'stopped'));
      const state = await api({ type: 'GET_STATE' });
      await cdpSession.detach();
      return state;
    }
    async function inShadow(page, body, argument) {
      const cdpSession = await cdp(page);
      const { root: documentRoot } = await cdpSession.send('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await cdpSession.send('DOM.querySelector', { nodeId: documentRoot.nodeId, selector: '[data-docling-ui]' });
      const { node } = await cdpSession.send('DOM.describeNode', { nodeId, depth: 1, pierce: true });
      const { object } = await cdpSession.send('DOM.resolveNode', { backendNodeId: node.shadowRoots[0].backendNodeId });
      const result = await cdpSession.send('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: `function(argument) { ${body} }`,
        arguments: [{ value: argument }], returnByValue: true, awaitPromise: true
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    async function clickShadowButton(page, label) {
      let bounds;
      for (let attempt = 0; attempt < 50; attempt++) {
        bounds = await inShadow(page, 'const button = [...this.querySelectorAll("button")].find(item => item.textContent === argument && item.getClientRects().length); if (!button) return null; const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };', label);
        if (bounds) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(bounds, `Missing visible shadow button: ${label}`);
      await page.mouse.click(bounds.x, bounds.y);
    }
    async function screenshot(page, name) {
      await fs.mkdir(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: path.join(ARTIFACTS, name), fullPage: true });
    }
    async function openPopup() {
      const popup = await newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      return popup;
    }
    async function close() {
      await context?.close();
      await model.close();
      const resolvedScratch = path.resolve(scratch);
      const resolvedTemp = path.resolve(os.tmpdir());
      if (path.dirname(resolvedScratch) !== resolvedTemp || !path.basename(resolvedScratch).startsWith('docling-qa-')) {
        throw new Error('Refusing to remove a test directory outside the expected temporary location.');
      }
      await fs.rm(resolvedScratch, { recursive: true, force: true });
    }

    const options = await newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.waitForFunction(() => !document.querySelector('#profiles').textContent.includes('正在'));

    return {
      base: model.base,
      record,
      gate,
      issues: record.issues,
      requests: record.requests,
      analysisRequests: record.analysisRequests,
      presetRequests: record.presetRequests,
      extensionId,
      options,
      document,
      api,
      newPage,
      openPopup,
      restartExtension,
      inShadow,
      clickShadowButton,
      screenshot,
      close,
    };
  } catch (error) {
    await context?.close();
    await model.close();
    await fs.rm(scratch, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { startMockModel, modelRoutes, withExtension, openSession };
