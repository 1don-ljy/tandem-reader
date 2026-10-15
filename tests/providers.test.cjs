const { test } = require('node:test');
const assert = require('node:assert/strict');

const providers = import('../src/shared/providers.ts');

test('built-in presets use official public APIs and editable current model IDs', async () => {
  const { getProviderPreset } = await providers;
  const deepseek = getProviderPreset('deepseek');
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(deepseek.defaultModel, 'deepseek-flash');
  const glm = getProviderPreset('glm');
  assert.equal(glm.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(glm.defaultModel, 'glm-4.7-flash');
  for (const preset of [deepseek, glm]) {
    assert.ok(preset.models.some(model => model.id === preset.defaultModel));
    assert.equal(new URL(preset.docsUrl).protocol, 'https:');
  }
  assert.deepEqual(getProviderPreset('custom').models, []);
  assert.throws(() => getProviderPreset('unsupported'), /不支持/);
});

test('legacy profile inference recognizes exact official endpoints only', async () => {
  const { inferProvider, resolveProvider } = await providers;
  assert.equal(inferProvider('https://api.deepseek.com/v1/'), 'deepseek');
  assert.equal(inferProvider('https://open.bigmodel.cn/api/paas/v4/chat/completions'), 'glm');
  assert.equal(resolveProvider(undefined, 'https://api.deepseek.com'), 'deepseek');
  for (const url of ['https://api.deepseek.com.evil.example/v1', 'https://open.bigmodel.cn/api/coding/paas/v4', 'https://example.com/v1', 'http://localhost:8080/v1', 'invalid']) {
    assert.equal(inferProvider(url), 'custom');
  }
});

test('built-in provider mismatch is rejected while custom selection stays explicit', async () => {
  const { resolveProvider } = await providers;
  assert.equal(resolveProvider('deepseek', 'https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(resolveProvider('glm', 'https://open.bigmodel.cn/api/paas/v4'), 'glm');
  assert.equal(resolveProvider('custom', 'https://api.deepseek.com'), 'custom');
  assert.equal(resolveProvider('custom', 'https://my-model.example/api'), 'custom');
  for (const [provider, url] of [['deepseek', 'https://my-model.example'], ['glm', 'https://api.deepseek.com'], ['glm', 'https://open.bigmodel.cn/api/coding/paas/v4']]) {
    assert.throws(() => resolveProvider(provider, url), /公开接口/);
  }
  assert.throws(() => resolveProvider('unknown', 'https://my-model.example'), /服务商无效/);
});

test('provider-specific thinking options never leak to custom or unverified models', async () => {
  const { providerRequestOptions } = await providers;
  assert.deepEqual(providerRequestOptions('deepseek', 'deepseek-flash'), { thinking: { type: 'disabled' } });
  assert.deepEqual(providerRequestOptions('deepseek', 'deepseek-v4-pro'), { thinking: { type: 'disabled' } });
  for (const model of ['glm-4.7-flash', 'glm-4.7']) {
    assert.deepEqual(providerRequestOptions('glm', model), { thinking: { type: 'disabled' } });
  }
  for (const model of ['glm-5.3', 'glm-5.3-flash']) {
    assert.deepEqual(providerRequestOptions('glm', model), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  }
  for (const [provider, model] of [['custom', 'deepseek-flash'], ['custom', 'glm-4.7-flash'], ['custom', 'glm-5.3'], ['deepseek', 'future-model'], ['glm', 'future-model']]) {
    assert.deepEqual(providerRequestOptions(provider, model), {});
  }
});
