import type { RuleInput } from '../shared/types.ts';
import { MESSAGE_TYPES, send } from '../shared/protocol.ts';
import type { ContentRuntime } from './context.ts';
import { button, element, errorMessage } from './dom.ts';
import { isActive } from './state.ts';

function positionMenu(runtime: ContentRuntime, rect: DOMRect): void {
  const { menu } = runtime.ui;
  menu.hidden = false;
  const width = Math.min(350, innerWidth - 20);
  const height = menu.getBoundingClientRect().height;
  menu.style.left = `${Math.max(10, Math.min(rect.left, innerWidth - width - 10))}px`;
  menu.style.top = `${Math.max(10, Math.min(rect.bottom + 8, innerHeight - height - 12))}px`;
}

function selectionMenu(runtime: ContentRuntime): void {
  const { state } = runtime;
  const { menu, host } = runtime.ui;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const selected = selection.toString().trim();
  if (!selected || selected.length > 300) return;
  const range = selection.getRangeAt(0);
  const anchor = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (!anchor || host.contains(anchor) || anchor.closest('input, textarea, pre, code, [contenteditable]:not([contenteditable="false"])')) return;
  const rect = range.getBoundingClientRect();
  if (anchor.closest('.docling-translation')) {
    menu.replaceChildren(element('p', '请在原文中选择术语，以确保保存的是正确的英文词。'));
    menu.append(button('显示原文', () => { runtime.setMode('dual'); menu.hidden = true; }), button('关闭', () => { menu.hidden = true; }));
    positionMenu(runtime, rect);
    return;
  }
  const block = state.blocks.find(item => item.source.contains(range.startContainer) && item.source.contains(range.endContainer));
  if (!block) return;
  state.selection = { text: selected, block };
  menu.replaceChildren(element('p', selected, 'selected'));
  const actionLabel = element('label', '如何处理这个术语');
  const action = element('select');
  action.id = 'docling-term-action';
  actionLabel.htmlFor = action.id;
  for (const [value, label] of [['keep', '保留英文'], ['translate', '指定译法'], ['first', '首次中英对照']] as const) {
    const option = element('option', label);
    option.value = value;
    action.append(option);
  }
  const translationLabel = element('label', '中文译名');
  const translation = element('input');
  translation.type = 'text';
  translation.id = 'docling-term-translation';
  translation.maxLength = 160;
  translationLabel.htmlFor = translation.id;
  translationLabel.hidden = true;
  translation.hidden = true;
  action.addEventListener('change', () => {
    const hidden = action.value === 'keep';
    translation.hidden = hidden;
    translationLabel.hidden = hidden;
    positionMenu(runtime, rect);
  });
  const scopeLabel = element('label', '应用范围');
  const scope = element('select');
  scope.id = 'docling-term-scope';
  scopeLabel.htmlFor = scope.id;
  for (const [value, label] of [['collection', '这套文档'], ['page', '当前页面'], ['domain', '当前领域'], ['global', '所有文档']] as const) {
    const option = element('option', label);
    option.value = value;
    scope.append(option);
  }
  const scopeDetails = element('div', runtime.scopeValue(scope.value), 'scope');
  scope.addEventListener('change', () => { scopeDetails.textContent = runtime.scopeValue(scope.value); });
  const menuActions = element('div', undefined, 'row menu-actions');
  const save = button('保存规则', async () => {
    if (action.value !== 'keep' && !translation.value.trim()) {
      translation.setCustomValidity('请填写中文译名。');
      translation.reportValidity();
      translation.addEventListener('input', () => translation.setCustomValidity(''), { once: true });
      return;
    }
    save.disabled = true;
    try {
      const response = await send(MESSAGE_TYPES.SAVE_RULE, { rule: {
        term: selected,
        action: action.value as RuleInput['action'],
        translation: translation.value.trim(),
        scope: scope.value as RuleInput['scope'],
        scopeValue: runtime.scopeValue(scope.value),
        domain: state.context?.settings?.domain || '通用技术文档',
      } });
      if (isActive(state.run)) runtime.stopTranslation();
      runtime.markStale();
      menu.hidden = true;
      runtime.showToast(`已记住“${selected}”。点击“更新译文”应用到已有译文。`, async () => {
        if (response.previousRule) await send(MESSAGE_TYPES.SAVE_RULE, { rule: response.previousRule });
        else await send(MESSAGE_TYPES.DELETE_RULE, { id: response.rule.id });
        runtime.markStale();
      });
    } catch (error) {
      runtime.showError(error);
      save.disabled = false;
    }
  }, 'primary');
  menuActions.append(save, button('取消', () => { menu.hidden = true; }));
  const extras = element('div', undefined, 'row menu-actions');
  extras.append(button('这一段不翻译', () => runtime.saveSkip(block)), button('解释这里的含义', async event => {
    const control = event.currentTarget;
    if (!(control instanceof HTMLButtonElement)) return;
    control.disabled = true;
    const explanation = element('p', '正在结合本段解释…', 'explanation');
    explanation.setAttribute('role', 'status');
    menu.append(explanation);
    positionMenu(runtime, rect);
    try {
      const response = await send(MESSAGE_TYPES.EXPLAIN, { text: selected, context: block.originalText });
      explanation.textContent = response.text;
    } catch (error) { explanation.textContent = errorMessage(error); }
    control.disabled = false;
    positionMenu(runtime, rect);
  }));
  menu.append(actionLabel, action, translationLabel, translation, scopeLabel, scope, scopeDetails, menuActions, extras);
  positionMenu(runtime, rect);
}

/**
 * Registers the document-level selection listeners and returns the disposer used by `cleanup()`.
 */
export function attachSelectionMenu(runtime: ContentRuntime): () => void {
  const { host, menu } = runtime.ui;
  let selectionTimer: number | undefined;
  function onSelectionEnd(event: Event): void {
    if (event.composedPath().includes(host)) return;
    clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => selectionMenu(runtime), 60);
  }
  function onPointerDown(event: PointerEvent): void {
    if (!event.composedPath().includes(host)) menu.hidden = true;
  }
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') menu.hidden = true;
  }
  document.addEventListener('pointerup', onSelectionEnd);
  document.addEventListener('keyup', onSelectionEnd);
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown);
  return () => {
    clearTimeout(selectionTimer);
    document.removeEventListener('pointerup', onSelectionEnd);
    document.removeEventListener('keyup', onSelectionEnd);
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('keydown', onKeyDown);
  };
}
