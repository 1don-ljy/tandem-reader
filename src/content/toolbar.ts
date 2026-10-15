import type { Settings } from '../shared/types.ts';
import { MESSAGE_TYPES, send } from '../shared/protocol.ts';
import type { ContentRuntime, ToolbarUi } from './context.ts';
import { button, element } from './dom.ts';
import { TOOLBAR_STYLES } from './theme.ts';

export function createToolbar(runtime: ContentRuntime): ToolbarUi {
  const { state } = runtime;
  const host = element('div');
  host.dataset.doclingUi = 'true';
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');
  host.style.setProperty('inset', '0', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = element('style');
  style.textContent = TOOLBAR_STYLES;
  shadow.append(style);
  const toolbar = element('section', undefined, 'panel toolbar');
  toolbar.setAttribute('aria-label', 'Tandem Reader 阅读工具');
  const top = element('div', undefined, 'row top');
  const title = element('span', 'Tandem Reader', 'title');
  const topActions = element('div', undefined, 'row');
  const minimize = button('收起', () => {
    const compact = toolbar.classList.toggle('compact');
    minimize.textContent = compact ? '展开' : '收起';
    minimize.setAttribute('aria-expanded', String(!compact));
  });
  minimize.setAttribute('aria-expanded', 'true');
  const close = button('×', () => runtime.cleanup());
  close.setAttribute('aria-label', '关闭 Tandem Reader 并恢复页面');
  topActions.append(minimize, close);
  top.append(title, topActions);
  const body = element('div', undefined, 'body');
  const domain = element('div', '领域：尚未加载', 'quiet');
  const progress = element('div', '', 'status');
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  const modes = element('div', undefined, 'modes');
  modes.setAttribute('aria-label', '阅读显示模式');
  const modeButtons = new Map<Settings['mode'], HTMLButtonElement>();
  for (const [value, label] of [['source', '原文'], ['dual', '双语'], ['translation', '译文']] as const) {
    const control = button(label, () => runtime.setMode(value));
    control.setAttribute('aria-pressed', String(value === state.mode));
    modeButtons.set(value, control);
    modes.append(control);
  }
  const actions = element('div', undefined, 'row');
  const startButton = button('开始翻译', () => runtime.startTranslation(), 'primary');
  const stopButton = button('停止', () => runtime.stopTranslation());
  const updateButton = button('更新译文', () => runtime.startTranslation(true));
  const settingsButton = button('设置', async () => { await send(MESSAGE_TYPES.OPEN_OPTIONS, {}).catch(runtime.showError); });
  stopButton.hidden = true;
  updateButton.hidden = true;
  actions.append(startButton, stopButton, updateButton, settingsButton);
  const hint = element('p', '选中原文，可保留术语、指定译法或跳过整段。', 'quiet');
  const toast = element('div', undefined, 'toast');
  toast.hidden = true;
  body.append(domain, progress, modes, actions, hint, toast);
  toolbar.append(top, body);
  const menu = element('section', undefined, 'panel menu');
  menu.hidden = true;
  menu.setAttribute('aria-label', '所选文本操作');
  shadow.append(toolbar, menu);
  document.documentElement.append(host);
  return { host, shadow, toolbar, menu, toast, progress, domain, startButton, stopButton, updateButton, modeButtons };
}

export function setMode(runtime: ContentRuntime, mode: unknown): void {
  if (mode !== 'source' && mode !== 'dual' && mode !== 'translation') return;
  const { state, ui } = runtime;
  state.mode = mode;
  document.documentElement.dataset.doclingMode = mode;
  for (const [value, control] of ui.modeButtons) control.setAttribute('aria-pressed', String(mode === value));
  for (const block of state.blocks) {
    const reveal = block.output?.querySelector<HTMLButtonElement>('[data-docling-reveal-button]');
    if (reveal) reveal.hidden = mode !== 'translation';
  }
  runtime.render();
}
