const assert = require('node:assert/strict');

/**
 * Provider, credential and configuration scenarios.
 *
 * `order` is the position the scenario held in the original single-session smoke test.
 * Every scenario file is concatenated and sorted by `order`, so each one still runs
 * against the session state it was written for.
 */
module.exports = [
  {
    order: 1,
    name: 'preset autofill, editable model IDs, custom URL editing and unsaved-key clearing',
    async run({ options, presetRequests }) {
      await options.locator('#profile-key').fill('unsaved-dummy-key');
      await options.locator('#profile-provider').selectOption('deepseek');
      assert.equal(await options.locator('#profile-base-url').inputValue(), 'https://api.deepseek.com');
      assert.equal(await options.locator('#profile-model').inputValue(), 'deepseek-flash');
      assert.equal(await options.locator('#profile-base-url').evaluate(input => input.readOnly), true);
      assert.equal(await options.locator('#profile-key').inputValue(), '');
      await options.locator('#profile-model').fill('future-deepseek-model');
      assert.equal(await options.locator('#profile-model').inputValue(), 'future-deepseek-model');
      await options.locator('#profile-key').fill('another-unsaved-dummy-key');
      await options.locator('#profile-provider').selectOption('glm');
      assert.equal(await options.locator('#profile-base-url').inputValue(), 'https://open.bigmodel.cn/api/paas/v4');
      assert.equal(await options.locator('#profile-model').inputValue(), 'glm-4.7-flash');
      assert.equal(await options.locator('#profile-key').inputValue(), '');
      await options.locator('#profile-provider').selectOption('custom');
      assert.equal(await options.locator('#profile-base-url').evaluate(input => input.readOnly), false);
      assert.equal(presetRequests.length, 0);
    },
  },
  {
    order: 2,
    name: 'options save, session key redaction, provider connection',
    async run({ options, base, requests }) {
      await options.locator('#profile-name').fill('QA mock provider');
      await options.locator('#profile-base-url').fill(`${base}/v1`);
      await options.locator('#profile-model').fill('mock-model');
      await options.locator('#profile-key').fill('qa-test-not-a-real-key');
      await options.locator('#key-persistence').selectOption('session');
      await options.locator('#save-profile').click();
      await options.waitForFunction(() => document.querySelector('#profiles').textContent.includes('QA mock provider'));
      assert.equal(await options.locator('#profile-key').inputValue(), '');
      await options.locator('#test-profile').click();
      await options.waitForFunction(() => document.querySelector('#connection-result').textContent.includes('连接成功'));
      assert.equal(requests.at(-1).authorization, 'Bearer qa-test-not-a-real-key');
    },
  },
  {
    order: 3,
    name: 'blank-key edit retention, settings hash navigation, key-free export',
    async run({ options, api, base }) {
      const beforeEdit = await api({ type: 'GET_STATE' });
      assert.equal(beforeEdit.profiles.length, 1);
      assert.equal(JSON.stringify(beforeEdit).includes('qa-test-not-a-real-key'), false);
      await options.locator('#profile-model').fill('mock-model-updated');
      await options.locator('#save-profile').click();
      await options.waitForFunction(() => document.querySelector('#profiles').textContent.includes('mock-model-updated'));
      const afterEdit = await api({ type: 'GET_STATE' });
      assert.equal(afterEdit.profiles[0].hasKey, true);
      assert.equal(afterEdit.profiles[0].provider, 'custom');
      await options.locator('a[href="#terms"]').click();
      await options.locator('#rule-term').fill('session');
      await options.locator('#rule-action').selectOption('first');
      await options.locator('#rule-translation').fill('会话');
      await options.locator('#rule-scope').selectOption('collection');
      await options.locator('#rule-scope-value').fill(`${base}/docs/`);
      await options.locator('#save-rule').click();
      await options.waitForFunction(() => document.querySelector('#rules').textContent.includes('session'));
      const exported = await api({ type: 'EXPORT_CONFIG' });
      assert.equal(JSON.stringify(exported).includes('qa-test-not-a-real-key'), false);
    },
  },
  {
    order: 22,
    name: 'config import retains same-connection key but drops it for endpoint/storage changes',
    async run({ options, api, base }) {
      const backup = (await api({ type: 'EXPORT_CONFIG' })).config;
      const invalidImport = structuredClone(backup);
      invalidImport.profiles[0].model = 'must-not-be-saved';
      invalidImport.memories = [{ scope: 'invalid' }];
      const invalidImportResult = await options.evaluate(config => chrome.runtime.sendMessage({ type: 'IMPORT_CONFIG', config }), invalidImport);
      assert.equal(invalidImportResult.ok, false);
      assert.equal((await api({ type: 'GET_STATE' })).profiles[0].model, backup.profiles[0].model);
      const roundTrip = await api({ type: 'IMPORT_CONFIG', config: backup });
      assert.equal(roundTrip.profiles[0].hasKey, true);
      const persistenceChange = structuredClone(backup);
      persistenceChange.profiles[0].keyPersistence = 'local';
      const persistenceResult = await api({ type: 'IMPORT_CONFIG', config: persistenceChange });
      assert.equal(persistenceResult.profiles[0].hasKey, false);
      assert.deepEqual(await options.evaluate(async () => (await chrome.storage.local.get('localKeys')).localKeys), {});
      await api({ type: 'SAVE_PROFILE', profile: backup.profiles[0], apiKey: 'qa-test-not-a-real-key' });
      const endpointChange = structuredClone(backup);
      endpointChange.profiles[0].baseUrl = `${base}/different-service/v1`;
      const endpointResult = await api({ type: 'IMPORT_CONFIG', config: endpointChange });
      assert.equal(endpointResult.profiles[0].hasKey, false);
      assert.equal(JSON.stringify(await options.evaluate(async () => await chrome.storage.session.get('sessionKeys'))).includes('qa-test-not-a-real-key'), false);
    },
  },
  {
    order: 23,
    name: 'provider mismatch and blank-key endpoint edits reject without modifying stored keys',
    async run({ options, api }) {
      const backup = (await api({ type: 'EXPORT_CONFIG' })).config;
      await api({ type: 'SAVE_PROFILE', profile: backup.profiles[0], apiKey: 'qa-test-not-a-real-key' });
      const keysBeforeMismatch = await options.evaluate(async () => ({ local: await chrome.storage.local.get('localKeys'), session: await chrome.storage.session.get('sessionKeys') }));
      const mismatchResult = await options.evaluate(profile => chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', profile: { ...profile, provider: 'deepseek' }, apiKey: 'must-not-store-this-key' }), backup.profiles[0]);
      assert.equal(mismatchResult.ok, false);
      assert.match(mismatchResult.error, /公开接口/);
      const endpointEditResult = await options.evaluate(profile => chrome.runtime.sendMessage({ type: 'SAVE_PROFILE', profile: { ...profile, baseUrl: `${profile.baseUrl}/changed` } }), backup.profiles[0]);
      assert.equal(endpointEditResult.ok, false);
      assert.match(endpointEditResult.error, /重新填写 Key/);
      assert.deepEqual(await options.evaluate(async () => ({ local: await chrome.storage.local.get('localKeys'), session: await chrome.storage.session.get('sessionKeys') })), keysBeforeMismatch);
      assert.equal((await api({ type: 'GET_STATE' })).profiles[0].baseUrl, backup.profiles[0].baseUrl);
    },
  },
  {
    order: 24,
    name: 'official provider requests intercepted locally, direct destinations, metadata export and legacy import',
    async run({ options, api, presetRequests, screenshot }) {
      await options.reload();
      for (const [provider, name, model, endpoint] of [
        ['deepseek', 'QA DeepSeek', 'deepseek-flash', 'https://api.deepseek.com/chat/completions'],
        ['glm', 'QA GLM', 'glm-4.7-flash', 'https://open.bigmodel.cn/api/paas/v4/chat/completions']
      ]) {
        await options.locator('#new-profile').click();
        await options.locator('#profile-provider').selectOption(provider);
        await options.locator('#profile-name').fill(name);
        await options.locator('#profile-key').fill(`mock-${provider}-key`);
        await options.locator('#save-profile').click();
        await options.waitForFunction(name => document.querySelector('#profiles').textContent.includes(name), name);
        assert.equal(await options.locator('#profile-key').inputValue(), '');
        const saved = (await api({ type: 'GET_STATE' })).profiles.find(profile => profile.name === name);
        assert.equal(saved.provider, provider);
        assert.equal(saved.model, model);
        await options.locator('#test-profile').click();
        await options.waitForFunction(() => document.querySelector('#connection-result').textContent.includes('连接成功'));
        assert.equal(presetRequests.at(-1).url, endpoint);
        assert.equal(presetRequests.at(-1).body.model, model);
        assert.equal(presetRequests.at(-1).authorization, `Bearer mock-${provider}-key`);
        assert.equal(JSON.stringify(presetRequests.at(-1).body).includes(`mock-${provider}-key`), false);
        assert.deepEqual(presetRequests.at(-1).body.thinking, { type: 'disabled' });
      }
      assert.equal(presetRequests.length, 2);
      const providerBackup = (await api({ type: 'EXPORT_CONFIG' })).config;
      assert.deepEqual(providerBackup.profiles.map(profile => profile.provider), ['custom', 'deepseek', 'glm']);
      assert.doesNotMatch(JSON.stringify(providerBackup), /mock-deepseek-key|mock-glm-key/);
      const legacyBackup = structuredClone(providerBackup);
      for (const profile of legacyBackup.profiles) delete profile.provider;
      const restoredLegacy = await api({ type: 'IMPORT_CONFIG', config: legacyBackup });
      assert.deepEqual(restoredLegacy.profiles.map(profile => profile.provider), ['custom', 'deepseek', 'glm']);
      assert.ok(restoredLegacy.profiles.every(profile => profile.hasKey));
      const badProviderImport = structuredClone(providerBackup);
      badProviderImport.profiles[0].provider = 'glm';
      const badProviderResult = await options.evaluate(config => chrome.runtime.sendMessage({ type: 'IMPORT_CONFIG', config }), badProviderImport);
      assert.equal(badProviderResult.ok, false);
      assert.deepEqual((await api({ type: 'GET_STATE' })).profiles, restoredLegacy.profiles);
      await screenshot(options, 'provider-settings.png');
    },
  },
];
