import { normalizeEndpoint } from '../../shared/core.ts';
import { MESSAGE_TYPES } from '../../shared/protocol.ts';
import { PROVIDER_PRESETS, getProviderPreset, inferProvider } from '../../shared/providers.ts';
import type { ProviderId } from '../../shared/providers.ts';
import type { ModelProfile, PublicProfile } from '../../shared/types.ts';
import type { OptionsRuntime } from '../context.ts';
import { $, actionButton, element, notice } from '../dom.ts';
import { send } from '../messaging.ts';

export function permissionOrigin(baseUrl: string) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请填写完整的 Base URL，例如 https://api.example.com/v1。'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('远程模型服务必须使用 HTTPS。HTTP 仅用于 localhost 或 127.0.0.1 本机服务。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Base URL 不应包含用户名、密码、查询参数或片段。请将 Key 填入独立字段。');
  }
  return `${url.origin}/*`;
}

export function requestOrigin(baseUrl: string) {
  // Called directly from Save/Test clicks so the browser can show a permission prompt.
  return chrome.permissions.request({ origins: [permissionOrigin(baseUrl)] });
}

export function renderProfiles(runtime: OptionsRuntime) {
  const list = $('profiles');
  list.replaceChildren();
  if (!runtime.state.profiles.length) {
    list.append(element('div', 'empty-state', '还没有模型配置。\n在右侧填写服务地址与模型 ID，即可开始。'));
  }
  for (const profile of runtime.state.profiles) {
    const active = profile.id === runtime.state.settings.activeProfileId;
    const card = element('article', `profile-card${active ? ' is-active' : ''}`);
    card.append(element('h3', '', profile.name));
    const provider = getProviderPreset(profile.provider || inferProvider(profile.baseUrl));
    card.append(element('p', 'profile-meta', `${provider?.name || '自定义兼容接口'} · ${profile.model}`));
    card.append(element('p', 'profile-meta', profile.baseUrl));
    card.append(element('span', 'profile-tag', `${active ? '当前使用 · ' : ''}${profile.hasKey ? (profile.keyPersistence === 'local' ? 'Key 存于本机' : 'Key 存于本次会话') : '未保存 Key'}`));
    const actions = element('div', 'form-actions');
    actions.append(actionButton('编辑', 'text-button', () => editProfile(runtime, profile)));
    if (!active) actions.append(actionButton('设为当前', 'text-button', async () => {
      await send(MESSAGE_TYPES.SAVE_SETTINGS, { settings: { activeProfileId: profile.id } });
      await runtime.reloadState();
      notice(`已选择「${profile.name}」。`);
    }));
    actions.append(actionButton('删除', 'danger-button', async () => {
      if (!confirm(`删除「${profile.name}」及其保存的 Key？`)) return;
      await send(MESSAGE_TYPES.DELETE_PROFILE, { id: profile.id });
      if ($('profile-id').value === profile.id) resetProfile(runtime);
      await runtime.reloadState();
      notice('模型配置已删除。');
    }));
    card.append(actions);
    list.append(card);
  }
}

export function updateStorageHint() {
  $('key-storage-hint').textContent = $('key-persistence').value === 'local'
    ? 'Key 将保存在本机扩展存储，不会同步；这种存储本身不加密。'
    : '浏览器关闭或扩展重载后，需要重新填写。';
}

export function renderProviderFields() {
  const providerId = $('profile-provider').value as ProviderId;
  const preset = getProviderPreset(providerId);
  const isCustom = providerId === 'custom';
  $('profile-base-url').readOnly = !isCustom;
  $('provider-models').replaceChildren();
  for (const model of preset?.models || []) $('provider-models').append(new Option(model.name, model.id));
  $('profile-endpoint-hint').textContent = isCustom
    ? '填写接口根地址，插件会连接其 /chat/completions 接口。允许 HTTPS，或本机 HTTP 服务。'
    : '已填写官方接口地址。使用其他区域、网关或代理地址时，请选择“自定义兼容接口”。';
  $('profile-model-hint').textContent = isCustom
    ? '按服务商文档填写模型 ID。URL、模型名称与 Key 均由你配置。'
    : '可从建议清单选择，也可填写该服务支持的其他模型 ID。预置清单核对于 2026-10-14。';
  $('provider-docs').hidden = isCustom || !preset?.docsUrl;
  if (!isCustom && preset?.docsUrl) $('provider-docs').href = preset.docsUrl;
  else $('provider-docs').removeAttribute('href');
}

export function updateProfileKeyHint(runtime: OptionsRuntime) {
  const saved = runtime.state.profiles.find((profile) => profile.id === $('profile-id').value);
  let endpointChanged = false;
  if (saved?.hasKey) {
    try { endpointChanged = normalizeEndpoint($('profile-base-url').value).baseUrl !== saved.baseUrl; }
    catch { endpointChanged = true; }
  }
  $('key-state').textContent = saved?.hasKey ? (endpointChanged ? '接口已变化，需要重新填写' : '已保存，留空保留') : '尚未保存';
  $('profile-key').placeholder = endpointChanged
    ? '填写此服务的 API Key'
    : saved?.hasKey ? '留空保留原 Key；填写以替换' : '粘贴你的 API Key';
  $('profile-key-hint').textContent = endpointChanged
    ? '接口地址已变化。请重新填写此服务的 Key，原 Key 不会自动带入。'
    : '编辑已有配置时，留空会保留原 Key。Key 不会显示在此页面。';
}

export function resetProfile(runtime: OptionsRuntime) {
  $('profile-form').reset();
  $('profile-id').value = '';
  $('profile-form-title').textContent = '添加模型配置';
  $('key-state').textContent = '';
  $('profile-key').placeholder = '粘贴你的 API Key';
  $('test-profile').disabled = true;
  $('connection-result').textContent = '保存配置不会自动发起模型请求。';
  $('connection-result').classList.remove('connection-error');
  renderProviderFields();
  updateProfileKeyHint(runtime);
  updateStorageHint();
}

export function editProfile(runtime: OptionsRuntime, profile: PublicProfile) {
  $('profile-id').value = profile.id;
  $('profile-provider').value = profile.provider || inferProvider(profile.baseUrl);
  $('profile-name').value = profile.name;
  $('profile-base-url').value = profile.baseUrl;
  $('profile-model').value = profile.model;
  $('profile-key').value = '';
  $('key-persistence').value = profile.keyPersistence || 'session';
  $('profile-form-title').textContent = '编辑模型配置';
  $('key-state').textContent = profile.hasKey ? '已保存，留空保留' : '尚未保存';
  $('profile-key').placeholder = profile.hasKey ? '留空保留原 Key；填写以替换' : '粘贴你的 API Key';
  $('test-profile').disabled = false;
  $('connection-result').textContent = '连接尚未测试。测试按钮使用已保存的配置。';
  $('connection-result').classList.remove('connection-error');
  renderProviderFields();
  updateProfileKeyHint(runtime);
  updateStorageHint();
  $('profile-name').focus();
}

export function bindProfiles(runtime: OptionsRuntime): void {
  $('new-profile').addEventListener('click', () => { resetProfile(runtime); $('profile-name').focus(); });
  $('profile-provider').addEventListener('change', () => {
    const preset = getProviderPreset($('profile-provider').value as ProviderId);
    const name = $('profile-name').value.trim();
    if (!name || name === '自定义模型' || PROVIDER_PRESETS.some((item) => item.name === name)) {
      $('profile-name').value = preset?.name || '自定义模型';
    }
    if (preset && preset.id !== 'custom') {
      $('profile-base-url').value = preset.baseUrl;
      $('profile-model').value = preset.defaultModel;
    }
    $('profile-key').value = '';
    renderProviderFields();
    updateProfileKeyHint(runtime);
    $('connection-result').textContent = $('profile-id').value
      ? '配置有未保存的变更。测试按钮仍使用已保存的配置。'
      : '保存配置不会自动发起模型请求。';
    $('connection-result').classList.remove('connection-error');
  });
  $('profile-base-url').addEventListener('input', () => updateProfileKeyHint(runtime));
  $('key-persistence').addEventListener('change', updateStorageHint);
  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const profile: Omit<ModelProfile, 'id'> & { id?: string } = {
      provider: $('profile-provider').value as ProviderId,
      name: $('profile-name').value.trim(),
      baseUrl: $('profile-base-url').value.trim().replace(/\/+$/, ''),
      model: $('profile-model').value.trim(),
      keyPersistence: $('key-persistence').value as ModelProfile['keyPersistence'],
    };
    if ($('profile-id').value) profile.id = $('profile-id').value;
    if (!profile.name || !profile.model) return notice('配置名称和模型 ID 不能为空。', true);
    $('save-profile').disabled = true;
    $('test-profile').disabled = true;
    try {
      if (!await requestOrigin(profile.baseUrl)) throw new Error('未授予模型服务访问权限。授权后才能保存并使用该服务。');
      const oldProfileIds = new Set(runtime.state.profiles.map((item) => item.id));
      const payload: { profile: typeof profile; apiKey?: string } = { profile };
      if ($('profile-key').value.trim()) payload.apiKey = $('profile-key').value.trim();
      await send(MESSAGE_TYPES.SAVE_PROFILE, payload);
      $('profile-key').value = '';
      await runtime.reloadState();
      // The save response is the whole public state, so the record is located by the id we sent
      // (empty for a new profile) and then by the freshly added entry.
      const saved = runtime.state.profiles.find((item) => item.id === profile.id)
        || runtime.state.profiles.find((item) => !oldProfileIds.has(item.id))
        || runtime.state.profiles.find((item) => item.name === profile.name && item.baseUrl === profile.baseUrl && item.model === profile.model);
      if (saved) editProfile(runtime, saved);
      notice('模型配置已保存。可以测试连接，或回到网页开始翻译。');
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
    finally {
      $('save-profile').disabled = false;
      $('test-profile').disabled = !$('profile-id').value;
    }
  });
  $('test-profile').addEventListener('click', async () => {
    const profile = runtime.state.profiles.find((item) => item.id === $('profile-id').value);
    if (!profile) return;
    $('test-profile').disabled = true;
    $('connection-result').textContent = '正在测试已保存的配置…';
    $('connection-result').classList.remove('connection-error');
    try {
      if (!await requestOrigin(profile.baseUrl)) throw new Error('未授予模型服务访问权限。');
      const result = await send(MESSAGE_TYPES.TEST_PROFILE, { id: profile.id });
      $('connection-result').textContent = result.message || '测试请求已成功，模型服务能够响应。';
    } catch (error) {
      $('connection-result').textContent = error instanceof Error ? error.message : '操作未完成，请重试。';
      $('connection-result').classList.add('connection-error');
    } finally { $('test-profile').disabled = false; }
  });
}
