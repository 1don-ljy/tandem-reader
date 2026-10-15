import type { PublicState, Settings } from '../shared/types.ts';
import { MESSAGE_TYPES } from '../shared/protocol.ts';
import { send } from './messaging.ts';

type PopupElements = Record<'status' | 'profile-hint' | 'progress-region' | 'progress-label' | 'memory-hint' | 'context-source', HTMLElement>
  & Record<'start' | 'stop' | 'open-options', HTMLButtonElement>
  & Record<'domain' | 'remember-context' | 'auto-discover', HTMLInputElement>
  & { profile: HTMLSelectElement; context: HTMLTextAreaElement; progress: HTMLProgressElement; 'reading-settings': HTMLFormElement };
const $ = <K extends keyof PopupElements>(id: K): PopupElements[K] => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少界面元素：${id}`);
  return node as PopupElements[K];
};
let state: PublicState | undefined;
let busy = false;
let contextEdited = false;
let pageCanRemember = false;
let wasRunning = false;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

function showMessage(message: string, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}

function updateProfileHint() {
  const profile = state?.profiles.find((item) => item.id === $('profile').value);
  $('profile-hint').textContent = profile
    ? `${profile.model} · ${profile.hasKey ? '已保存 Key，连接状态需在设置页测试' : '未保存 Key；需要鉴权的服务请先在设置页填写'}`
    : '请先打开设置，添加模型服务和 API Key。';
  $('start').disabled = busy || !profile;
}

function renderMode(mode: Settings['mode']) {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
}

function renderState() {
  if (!state) return;
  $('profile').replaceChildren();
  if (!state.profiles.length) $('profile').add(new Option('尚未添加模型配置', ''));
  for (const profile of state.profiles) $('profile').add(new Option(profile.name, profile.id));
  $('profile').value = state.settings.activeProfileId || state.profiles[0]?.id || '';
  if (!$('profile').value && state.profiles.length) $('profile').selectedIndex = 0;
  $('domain').value = state.settings.domain || '';
  $('context').value = state.settings.context || '';
  $('auto-discover').checked = state.settings.autoDiscover !== false;
  renderMode(state.settings.mode || 'dual');
  updateProfileHint();
}

async function saveSettings(remember = false) {
  const settings: Partial<Settings> = {
    activeProfileId: $('profile').value,
    autoDiscover: $('auto-discover').checked,
  };
  const payload: { settings: Partial<Settings>; rememberForCollection?: boolean } = { settings };
  if (contextEdited) {
    settings.domain = $('domain').value.trim();
    settings.context = $('context').value.trim();
    if (remember) payload.rememberForCollection = pageCanRemember && $('remember-context').checked;
  }
  await send(MESSAGE_TYPES.SAVE_SETTINGS, payload);
  if (state) Object.assign(state.settings, settings);
}

async function restoreDocumentContext() {
  try {
    const page = await send(MESSAGE_TYPES.GET_ACTIVE_PAGE, {});
    pageCanRemember = true;
    if (!contextEdited) {
      $('domain').value = page.settings.domain;
      $('context').value = page.settings.context;
      const source = page.contextSource || (page.memory ? 'manual-memory' : page.domainMemory && page.settings.autoDiscover !== false ? 'automatic' : 'default');
      $('context-source').textContent = source === 'manual-session'
        ? '来源：本页本次阅读的人工设置，优先于自动识别。'
        : source === 'manual-memory'
          ? `来源：你确认的${page.memory?.scope === 'page' ? '页面' : '文档集'}记忆，优先于自动识别。`
          : source === 'automatic' && page.domainMemory
            ? `来源：自动领域记忆，已分析 ${page.domainMemory.documents.length} 篇文档、${page.domainMemory.terms.length} 个术语。`
            : page.settings.autoDiscover === false
              ? '来源：默认阅读提示。自动识别已关闭，已有自动分析不参与本次翻译。'
              : '来源：默认阅读提示。启用自动识别后，点击开始会先分析文档领域与术语。';
    }
    $('remember-context').disabled = !contextEdited;
    $('memory-hint').textContent = `仅在你修改后保存人工记忆，应用于：${page.collectionUrl}`;
  } catch {
    pageCanRemember = false;
    $('remember-context').checked = false;
    $('remember-context').disabled = true;
    $('memory-hint').textContent = '打开 HTTP / HTTPS 文档页面后，可以保存这套文档的领域上下文。';
  }
}

async function refreshStatus() {
  try {
    const { status } = await send(MESSAGE_TYPES.GET_STATUS, {});
    if (!status) return;
    if (['source', 'dual', 'translation'].includes(status.mode)) {
      renderMode(status.mode);
      if (state) state.settings.mode = status.mode;
    }
    const total = Number(status.total) || 0;
    const done = Number(status.done) || 0;
    const failed = Number(status.failed) || 0;
    $('progress-region').hidden = total === 0;
    $('progress').max = Math.max(total, 1);
    $('progress').value = Math.min(done + failed, total);
    $('progress-label').textContent = `${status.running ? '翻译中' : '已结束'} · ${done} / ${total} 段已完成${failed ? `，${failed} 段失败，可在页面重试` : ''}`;
    $('stop').disabled = !status.running;
    clearTimeout(statusTimer);
    if (status.running) statusTimer = setTimeout(refreshStatus, 1200);
    else if (wasRunning) await restoreDocumentContext();
    wasRunning = status.running;
  } catch {
    // Some browser pages cannot host the reading panel; START reports that error.
  }
}

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('profile').addEventListener('change', async () => {
  updateProfileHint();
  try { await saveSettings(); } catch (error) { showMessage(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
});
for (const id of ['domain', 'context'] as const) {
  $(id).addEventListener('input', () => {
    contextEdited = true;
    $('remember-context').disabled = !pageCanRemember;
    $('context-source').textContent = '你正在修改阅读上下文；这些人工设置优先于自动识别。';
  });
  $(id).addEventListener('change', async () => {
    try { await saveSettings(); } catch (error) { showMessage(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
  });
}
$('auto-discover').addEventListener('change', async () => {
  try {
    await saveSettings();
    await restoreDocumentContext();
    showMessage($('auto-discover').checked ? '已启用。开始翻译时会先分析尚未记住的文档。' : '已关闭自动识别；后续翻译仍遵循你的人工设置。');
  } catch (error) {
    $('auto-discover').checked = state?.settings.autoDiscover !== false;
    showMessage(error instanceof Error ? error.message : '操作未完成，请重试。', true);
  }
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', async () => {
    const previousMode = state?.settings.mode || 'dual';
    const mode = button.dataset.mode;
    if (mode !== 'source' && mode !== 'dual' && mode !== 'translation') return;
    renderMode(mode);
    try {
      await send(MESSAGE_TYPES.SET_MODE, { mode });
      if (state) state.settings.mode = mode;
      showMessage('阅读方式已更新，不会重新请求翻译。');
    } catch (error) {
      renderMode(previousMode);
      showMessage(error instanceof Error ? error.message : '操作未完成，请重试。', true);
    }
  });
}
$('reading-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !state) return;
  busy = true;
  updateProfileHint();
  showMessage('正在准备当前页面…');
  try {
    await saveSettings(true);
    await send(MESSAGE_TYPES.START, {});
    contextEdited = false;
    $('remember-context').disabled = true;
    wasRunning = true;
    showMessage($('auto-discover').checked ? '已开始，先分析文档领域与术语，再翻译正文。已有分析会复用。' : '已开始翻译。选中术语可以调整译法。');
    $('stop').disabled = false;
    await refreshStatus();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : '操作未完成，请重试。', true);
  } finally {
    busy = false;
    updateProfileHint();
  }
});
$('stop').addEventListener('click', async () => {
  try {
    await send(MESSAGE_TYPES.STOP, {});
    clearTimeout(statusTimer);
    showMessage('已停止。原文与已完成的译文会保留。');
    $('stop').disabled = true;
    await refreshStatus();
  } catch (error) { showMessage(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
});

try {
  state = await send(MESSAGE_TYPES.GET_STATE, {});
  renderState();
  await restoreDocumentContext();
  await refreshStatus();
} catch (error) {
  $('start').disabled = true;
  showMessage(error instanceof Error ? error.message : '操作未完成，请重试。', true);
}
