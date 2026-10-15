import type { PublicState } from '../shared/types.ts';
import { MESSAGE_TYPES } from '../shared/protocol.ts';
import type { OptionsRuntime } from './context.ts';
import { notice } from './dom.ts';
import { send } from './messaging.ts';
import { bindData, renderSessions, renderSkips } from './options/data.ts';
import { bindDiagnostics } from './options/diagnostics.ts';
import { bindMemory, renderDomainMemories, renderMemories, updateMemoryFields } from './options/memory.ts';
import { bindProfiles, renderProfiles, renderProviderFields, updateStorageHint } from './options/models.ts';
import { bindRules, renderRules, updateRuleFields } from './options/terms.ts';

let state: PublicState = {
  settings: { activeProfileId: '', domain: '', context: '', mode: 'dual', targetLanguage: '简体中文', autoDiscover: true },
  profiles: [], rules: [], skips: [], memories: [], sessions: [], domainMemories: [],
};

const runtime: OptionsRuntime = {
  get state() { return state; },
  async reloadState() {
    state = await send(MESSAGE_TYPES.GET_STATE, {});
    renderProfiles(runtime);
    renderRules(runtime);
    renderSkips(runtime);
    renderMemories(runtime);
    renderDomainMemories(runtime);
    renderSessions(runtime);
  },
};

bindProfiles(runtime);
bindRules(runtime);
bindMemory(runtime);
bindData(runtime);
bindDiagnostics();

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  try { await runtime.reloadState(); }
  catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
});

updateStorageHint();
renderProviderFields();
updateRuleFields();
updateMemoryFields();
try { await runtime.reloadState(); }
catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
