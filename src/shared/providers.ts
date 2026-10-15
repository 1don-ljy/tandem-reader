import { normalizeEndpoint } from './core.ts';

export type ProviderId = 'deepseek' | 'glm' | 'custom';
export interface ProviderPreset {
  id: ProviderId;
  name: string;
  baseUrl: string;
  defaultModel: string;
  models: { id: string; name: string }[];
  docsUrl: string;
}

// Curated from the providers' public API documentation, verified 2026-10-14.
// A new model ID can be entered without changing the extension.
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }
    ],
    docsUrl: 'https://api-docs.deepseek.com/'
  },
  {
    id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.7-flash',
    models: [
      { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
      { id: 'glm-5.3', name: 'GLM-5.3' },
      { id: 'glm-5.2', name: 'GLM-5.2' },
      { id: 'glm-4.7', name: 'GLM-4.7' }
    ],
    docsUrl: 'https://docs.bigmodel.cn/cn/api/introduction'
  },
  { id: 'custom', name: '自定义模型', baseUrl: '', defaultModel: '', models: [], docsUrl: '' }
];

export function getProviderPreset(id: ProviderId): ProviderPreset {
  const preset = PROVIDER_PRESETS.find(item => item.id === id);
  if (!preset) throw new Error('不支持的模型服务商，请选择自定义模型。');
  return preset;
}

export function inferProvider(baseUrl: string): ProviderId {
  try {
    const { baseUrl: normalized } = normalizeEndpoint(baseUrl);
    if (['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(normalized)) return 'deepseek';
    if (normalized === 'https://open.bigmodel.cn/api/paas/v4') return 'glm';
  } catch { /* Legacy invalid endpoints are handled by the profile editor. */ }
  return 'custom';
}

export function resolveProvider(provider: unknown, baseUrl: string): ProviderId {
  if (provider === undefined) return inferProvider(baseUrl);
  if (provider !== 'deepseek' && provider !== 'glm' && provider !== 'custom') throw new Error('服务商无效，请重新选择。');
  if (provider !== 'custom' && inferProvider(baseUrl) !== provider) {
    throw new Error('所选服务商需要使用其公开接口地址；其他地址请使用自定义模型。');
  }
  return provider;
}

export function providerRequestOptions(provider: ProviderId, model: string): { thinking?: { type: 'disabled' | 'enabled' }; reasoning_effort?: 'low' } {
  // Apply only documented model-specific settings. Custom and unverified
  // model IDs retain the API's defaults.
  if (provider === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model)) {
    return { thinking: { type: 'disabled' } };
  }
  if (provider === 'glm' && ['glm-4.7-flash', 'glm-4.7'].includes(model)) {
    return { thinking: { type: 'disabled' } };
  }
  // GLM-5.3 requires thinking; the documented low effort is appropriate for
  // short translation requests. Sending "disabled" would fail these models.
  if (provider === 'glm' && ['glm-5.3', 'glm-5.3-flash'].includes(model)) {
    return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
  }
  return {};
}
