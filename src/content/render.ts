import type { ContentStatus } from '../shared/types.ts';
import type { ToolbarUi } from './context.ts';
import { isActive, type ReadingState, type TranslationBlock } from './state.ts';

/** Everything the toolbar shows, derived from state alone. Pure and DOM-free. */
export interface ToolbarView {
  progress: string;
  active: boolean;
  startLabel: string;
  startDisabled: boolean;
  stopVisible: boolean;
  updateVisible: boolean;
  updateDisabled: boolean;
  domain: string;
  domainNote: string;
  domainTitle: string;
}

export function toolbarView(state: ReadingState, status: ContentStatus): ToolbarView {
  const active = isActive(state.run);
  return {
    progress: state.run.kind === 'translating'
      ? `正在翻译 ${status.done + status.failed} / ${status.total} 段${status.failed ? `，${status.failed} 段失败` : ''}`
      : state.message,
    active,
    startLabel: status.done || status.failed ? '继续翻译' : '开始翻译',
    startDisabled: active,
    stopVisible: active,
    updateVisible: state.stale,
    updateDisabled: active,
    domain: state.context?.settings?.domain || '通用技术文档',
    domainNote: state.context?.settings.autoDiscover !== false
      ? state.analysisNote || (state.context?.domainMemory ? `已记住 ${state.context.domainMemory.terms.length} 个术语` : '')
      : '',
    domainTitle: state.context?.settings?.context || '可在设置页补充领域背景。',
  };
}

/** Parameter-complete state -> DOM mapping: the same view always renders the same toolbar. */
export function renderToolbar(ui: ToolbarUi, view: ToolbarView): void {
  ui.progress.textContent = view.progress;
  ui.startButton.hidden = view.active;
  ui.startButton.disabled = view.startDisabled;
  ui.startButton.textContent = view.startLabel;
  ui.stopButton.hidden = !view.stopVisible;
  ui.updateButton.hidden = !view.updateVisible;
  ui.updateButton.disabled = view.updateDisabled;
  ui.domain.textContent = view.domain;
  if (view.domainNote) ui.domain.append(document.createTextNode(` · ${view.domainNote}`));
  ui.domain.title = view.domainTitle;
}

/** Translation flags for one block, derived from the block alone. Pure and DOM-free. */
export interface BlockView {
  state: 'pending' | 'done' | 'error';
  reveal: boolean;
}

export function blockView(block: TranslationBlock): BlockView {
  if (block.status === 'done') return { state: 'done', reveal: false };
  if (block.status === 'error') return { state: 'error', reveal: true };
  return { state: 'pending', reveal: true };
}

/** Parameter-complete block -> DOM mapping; `content` carries the translated nodes. */
export function renderBlock(block: TranslationBlock, content: Node[]): void {
  const view = blockView(block);
  block.source.dataset.doclingReveal = String(view.reveal);
  if (!block.output) return;
  block.output.dataset.doclingState = view.state;
  block.output.replaceChildren(...content);
}
