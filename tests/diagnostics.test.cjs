const { test } = require('node:test');
const assert = require('node:assert/strict');

const diagnosticsModule = import('../src/shared/diagnostics.ts');

test('diagnostic ring buffer keeps only the newest events', async () => {
  const { Diagnostics, DIAGNOSTIC_LIMIT } = await diagnosticsModule;
  assert.equal(DIAGNOSTIC_LIMIT, 200);
  const log = new Diagnostics();
  assert.equal(log.limit, DIAGNOSTIC_LIMIT);
  for (let index = 0; index < DIAGNOSTIC_LIMIT + 25; index++) {
    log.record({ at: index, type: 'TRANSLATE', phase: 'done', ok: true, durationMs: index });
  }
  const events = log.list();
  assert.equal(events.length, DIAGNOSTIC_LIMIT);
  assert.equal(events[0].at, 25, 'the oldest events must be dropped first');
  assert.equal(events.at(-1).at, DIAGNOSTIC_LIMIT + 24);
});

test('a custom limit is honoured', async () => {
  const { Diagnostics } = await diagnosticsModule;
  const log = new Diagnostics(3);
  for (let index = 0; index < 5; index++) log.record({ at: index, type: 'ANALYZE_DOCUMENT', phase: 'start', ok: true });
  assert.deepEqual(log.list().map(event => event.at), [2, 3, 4]);
});

test('recorded events only ever contain the whitelisted fields', async () => {
  const { Diagnostics } = await diagnosticsModule;
  const log = new Diagnostics();
  const recorded = log.record({
    at: Date.now(), type: 'TRANSLATE', phase: 'error', ok: false, tabId: 7, jobId: 'docling-1-ab', durationMs: 12, errorCode: 'timeout',
    // A caller could try to smuggle content in; none of it may survive.
    text: 'SECRET source paragraph', translation: 'SECRET 译文', apiKey: 'sk-secret', context: 'SECRET context', warning: 'SECRET warning',
  });
  assert.deepEqual(Object.keys(recorded).sort(), ['at', 'durationMs', 'errorCode', 'jobId', 'ok', 'phase', 'tabId', 'type']);
  const serialized = JSON.stringify(log.snapshot());
  for (const secret of ['SECRET', 'sk-secret']) assert.equal(serialized.includes(secret), false, `${secret} must never be recorded`);
});

test('missing or mistyped optional fields are omitted', async () => {
  const { Diagnostics } = await diagnosticsModule;
  const log = new Diagnostics();
  const event = log.record({ at: 1, type: 'GET_STATE', phase: 'done', ok: true, tabId: 'not-a-number', jobId: 42, durationMs: 'slow', errorCode: {} });
  assert.deepEqual(event, { at: 1, type: 'GET_STATE', phase: 'done', ok: true });
});

test('error classification returns codes, never messages', async () => {
  const { Diagnostics, classifyError, isDiagnosticErrorCode } = await diagnosticsModule;
  const samples = [
    [new Error('模型请求超过 25 秒，请重试此段或使用响应更快的模型。'), 'timeout'],
    [new Error('翻译已停止或规则已更新。'), 'aborted'],
    [new Error('无法连接模型接口，请检查网址、网络、访问授权和服务是否运行。'), 'offline'],
    [new Error('自动领域分析未完成，继续使用已有背景和规则。SECRET model output'), 'model-error'],
    [new Error('尚未授权此模型接口，请在设置页保存配置并允许访问。'), 'permission'],
    [new Error('不支持的操作，请刷新插件后重试。'), 'unsupported'],
    [new Error('SECRET source paragraph with sk-secret'), 'failed'],
  ];
  for (const [error, expected] of samples) {
    const code = classifyError(error);
    assert.equal(code, expected);
    assert.ok(isDiagnosticErrorCode(code), `${code} must be a known code`);
    assert.equal(code.includes('SECRET'), false);
    assert.equal(code.includes('sk-secret'), false);
  }
  const log = new Diagnostics();
  const event = log.record({ at: 1, type: 'TRANSLATE', phase: 'error', ok: false, errorCode: classifyError(new Error('SECRET sk-secret')) });
  assert.equal(JSON.stringify(event).includes('SECRET'), false);
});

test('snapshot exposes shape, limit and generatedAt and clears cleanly', async () => {
  const { Diagnostics } = await diagnosticsModule;
  const log = new Diagnostics(2);
  log.record({ at: 1, type: 'TRANSLATE', phase: 'start', ok: true });
  log.record({ at: 2, type: 'TRANSLATE', phase: 'done', ok: true, durationMs: 5 });
  const snapshot = log.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.limit, 2);
  assert.equal(snapshot.events.length, 2);
  assert.ok(snapshot.generatedAt > 0);
  assert.deepEqual(Object.keys(snapshot.events[0]).sort(), ['at', 'ok', 'phase', 'type']);
  log.clear();
  assert.deepEqual(log.snapshot().events, []);
});

test('list returns copies so callers cannot mutate stored events', async () => {
  const { Diagnostics } = await diagnosticsModule;
  const log = new Diagnostics();
  log.record({ at: 1, type: 'TRANSLATE', phase: 'done', ok: true });
  const [first] = log.list();
  first.type = 'MUTATED';
  assert.equal(log.list()[0].type, 'TRANSLATE');
});
