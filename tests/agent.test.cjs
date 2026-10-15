const { test } = require('node:test');
const assert = require('node:assert/strict');

const runtime = import('../src/agent/translation-agent.ts');
const sdk = import('@earendil-works/pi-ai');
const connection = {
  profile: { id: 'profile', name: 'Test model', model: 'mock-model', baseUrl: 'https://example.com/v1', keyPersistence: 'session' },
  baseUrl: 'https://example.com/v1', endpoint: 'https://example.com/v1/chat/completions', origin: 'https://example.com/*', local: false,
  apiKey: 'test-key-never-in-transcript',
};
const messages = [{ role: 'system', content: 'Translate only the current technical paragraph.' }, { role: 'user', content: 'Current paragraph' }];
const history = [{ source: 'Previous source', translation: '上一段译文', heading: 'Testing', at: 1 }];

function assistant(model, text, stopReason = 'stop') {
  return { role: 'assistant', content: [{ type: 'text', text }], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

test('real Pi Agent restores history, emits lifecycle events and keeps key out of model context', async () => {
  const { runTranslationAgent } = await runtime;
  const { createAssistantMessageEventStream } = await sdk;
  let observed;
  const events = [];
  const streamFn = (model, context) => {
    observed = { model, context };
    const stream = createAssistantMessageEventStream();
    const message = assistant(model, '当前段落译文');
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message);
    return stream;
  };
  const result = await runTranslationAgent(connection, messages, new AbortController().signal, history, event => events.push(event), streamFn);
  assert.equal(result, '当前段落译文');
  assert.deepEqual(observed.context.messages.map(message => message.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(observed.context.messages[1].content, 'Previous source');
  assert.equal(observed.context.messages[2].content[0].text, '上一段译文');
  assert.equal(observed.context.messages.at(-1).content, 'Current paragraph');
  assert.equal(events[0].type, 'agent_start');
  assert.equal(events.at(-1).type, 'agent_end');
  assert.ok(events.some(event => event.type === 'turn_end'));
  assert.equal(JSON.stringify({ observed, events }).includes(connection.apiKey), false);
});

test('failed current Agent turn cannot fall back to a successful historical answer', async () => {
  const { runTranslationAgent } = await runtime;
  const { createAssistantMessageEventStream } = await sdk;
  const streamFn = model => {
    const stream = createAssistantMessageEventStream();
    const message = { ...assistant(model, '', 'error'), errorMessage: 'simulated current failure' };
    stream.push({ type: 'error', reason: 'error', error: message });
    stream.end(message);
    return stream;
  };
  await assert.rejects(runTranslationAgent(connection, messages, new AbortController().signal, history, undefined, streamFn), /simulated current failure/);
});

test('Agent rejects truncated responses and respects cancellation before and during requests', async () => {
  const { runTranslationAgent } = await runtime;
  const { createAssistantMessageEventStream } = await sdk;
  const truncated = model => {
    const stream = createAssistantMessageEventStream();
    const message = assistant(model, 'incomplete', 'length');
    stream.push({ type: 'done', reason: 'length', message }); stream.end(message); return stream;
  };
  await assert.rejects(runTranslationAgent(connection, messages, new AbortController().signal, [], undefined, truncated), /截断/);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(runTranslationAgent(connection, messages, alreadyAborted.signal, [], undefined, () => { throw new Error('must not run'); }), /停止/);
  const controller = new AbortController();
  const waiting = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    options.signal.addEventListener('abort', () => {
      const message = { ...assistant(model, '', 'aborted'), errorMessage: 'request aborted' };
      stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(message);
    }, { once: true });
    queueMicrotask(() => controller.abort());
    return stream;
  };
  await assert.rejects(runTranslationAgent(connection, messages, controller.signal, [], undefined, waiting), /停止/);
});

test('Chat Completions transport keeps authentication in headers and emits SDK response events', async () => {
  const { createChatCompletionsStream } = await runtime;
  const { normalizeContext } = await sdk;
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: '译文' }, finish_reason: 'stop' }] }));
  };
  try {
    const model = { id: 'mock-model', api: 'openai-completions', provider: 'docling-compatible' };
    const context = normalizeContext({ messages: messages.map(message => ({ ...message, timestamp: 1 })) });
    const stream = createChatCompletionsStream(connection)(model, context, {});
    const events = [];
    for await (const event of stream) events.push(event.type);
    assert.equal((await stream.result()).content[0].text, '译文');
    assert.equal(request.url, connection.endpoint);
    assert.equal(request.options.headers.Authorization, `Bearer ${connection.apiKey}`);
    assert.equal(request.options.redirect, 'error');
    const body = JSON.parse(request.options.body);
    assert.equal(body.stream, false);
    assert.equal(body.messages.at(-1).content, 'Current paragraph');
    assert.equal(JSON.stringify(body).includes(connection.apiKey), false);
    assert.deepEqual(events, ['start', 'text_start', 'text_delta', 'text_end', 'done']);
  } finally { globalThis.fetch = originalFetch; }
});

test('transport returns protocol error events for network, HTTP and non-text completions', async () => {
  const { createChatCompletionsStream } = await runtime;
  const { normalizeContext } = await sdk;
  const originalFetch = globalThis.fetch;
  const model = { id: 'mock-model', api: 'openai-completions', provider: 'docling-compatible' };
  const context = normalizeContext({ messages: messages.map(message => ({ ...message, timestamp: 1 })) });
  try {
    for (const response of [
      () => { throw new TypeError('network offline'); },
      () => new Response('rate limited', { status: 429 }),
      () => new Response('not JSON'),
      () => new Response(JSON.stringify({ choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }] })),
      () => new Response(JSON.stringify({ choices: [{ message: { content: 'blocked' }, finish_reason: 'content_filter' }] })),
      () => new Response(JSON.stringify({ choices: [{ message: { content: 'call a tool', tool_calls: [{ id: 'call' }] }, finish_reason: 'tool_calls' }] }))
    ]) {
      globalThis.fetch = async () => response();
      const stream = createChatCompletionsStream(connection)(model, context, {});
      const result = await stream.result();
      assert.equal(result.stopReason, 'error');
      assert.ok(result.errorMessage);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('provider transport sends each configured model and key directly to its selected endpoint', async () => {
  const { createChatCompletionsStream } = await runtime;
  const { normalizeContext } = await sdk;
  const originalFetch = globalThis.fetch;
  const context = normalizeContext({ messages: messages.map(message => ({ ...message, timestamp: 1 })) });
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '译文', reasoning_content: 'Do not expose this reasoning.' }, finish_reason: 'stop' }] }));
  };
  try {
    for (const [provider, baseUrl, model] of [
      ['deepseek', 'https://api.deepseek.com', 'deepseek-flash'],
      ['glm', 'https://open.bigmodel.cn/api/paas/v4', 'glm-4.7-flash'],
      ['glm', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3'],
      ['custom', 'https://models.example/custom/v1', 'my-future-model'],
    ]) {
      const selected = { ...connection, profile: { ...connection.profile, provider, model, baseUrl }, baseUrl, endpoint: `${baseUrl}/chat/completions`, apiKey: `mock-key-${provider}` };
      const stream = createChatCompletionsStream(selected)({ id: model, api: 'openai-completions', provider: 'docling-compatible' }, context, {});
      const response = await stream.result();
      assert.equal(response.stopReason, 'stop');
      assert.deepEqual(response.content, [{ type: 'text', text: '译文' }]);
      assert.equal(seen.at(-1).url, selected.endpoint);
      assert.equal(seen.at(-1).body.model, model);
      assert.equal(seen.at(-1).headers.Authorization, `Bearer ${selected.apiKey}`);
      assert.equal(JSON.stringify(seen.at(-1).body).includes(selected.apiKey), false);
      if (provider === 'deepseek' || model === 'glm-4.7-flash') assert.deepEqual(seen.at(-1).body.thinking, { type: 'disabled' });
      if (model === 'glm-5.3') {
        assert.deepEqual(seen.at(-1).body.thinking, { type: 'enabled' });
        assert.equal(seen.at(-1).body.reasoning_effort, 'low');
      }
      if (provider === 'custom') {
        assert.equal(Object.hasOwn(seen.at(-1).body, 'thinking'), false);
        assert.equal(Object.hasOwn(seen.at(-1).body, 'reasoning_effort'), false);
      }
    }
    const mismatch = { ...connection, profile: { ...connection.profile, provider: 'deepseek' } };
    const rejected = await createChatCompletionsStream(mismatch)({ id: 'mock-model', api: 'openai-completions', provider: 'docling-compatible' }, context, {}).result();
    assert.equal(rejected.stopReason, 'error');
    assert.equal(seen.length, 4, 'Provider mismatch must reject before any network request');
  } finally { globalThis.fetch = originalFetch; }
});
