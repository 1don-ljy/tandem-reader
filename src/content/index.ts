import type { ContentStatus } from '../shared/types.ts';
import { MESSAGE_TYPES, send, type ContentPush } from '../shared/protocol.ts';
import type { ContentRuntime } from './context.ts';
import { button, element, errorMessage } from './dom.ts';
import { getStatus, scanBlocks } from './scan.ts';
import { attachSelectionMenu } from './selection-menu.ts';
import { renderToolbar, toolbarView } from './render.ts';
import { createState, isActive, type TranslationBlock } from './state.ts';
import { createToolbar, setMode } from './toolbar.ts';
import { markStale, removeBlockTranslation, retryBlock, saveSkip, scopeValue, startTranslation, stopTranslation } from './translate.ts';

(() => {
  const contentGlobal = globalThis as typeof globalThis & { __doclingContent?: boolean };
  if (contentGlobal.__doclingContent) return;
  contentGlobal.__doclingContent = true;

  const state = createState();

  function showError(error: unknown): void {
    state.message = errorMessage(error);
    runtime.render();
  }

  function showToast(message: string, undo?: () => void | Promise<void>): void {
    const { toast } = runtime.ui;
    toast.replaceChildren(element('span', message));
    state.undo = undo || null;
    if (undo) {
      toast.append(button('撤销', async () => {
        const operation = state.undo;
        if (!operation) return;
        state.undo = null;
        try {
          await operation();
          showToast('已撤销。');
        } catch (error) { showError(error); }
      }));
    }
    toast.hidden = false;
  }

  function cleanup(): void {
    runtime.stopTranslation();
    detachSelection();
    for (const block of state.blocks) removeBlockTranslation(block);
    delete document.documentElement.dataset.doclingMode;
    chrome.runtime.onMessage.removeListener(onMessage);
    runtime.ui.host.remove();
    delete contentGlobal.__doclingContent;
  }

  const runtime: ContentRuntime = {
    state,
    ui: undefined as unknown as ContentRuntime['ui'],
    cleanup: () => cleanup(),
    render: () => renderToolbar(runtime.ui, toolbarView(state, getStatus(state))),
    showError,
    showToast,
    setMode: mode => setMode(runtime, mode),
    startTranslation: (force = false) => startTranslation(runtime, force),
    stopTranslation: () => stopTranslation(runtime),
    retryBlock: (block: TranslationBlock) => retryBlock(runtime, block),
    markStale: () => markStale(runtime),
    saveSkip: (block: TranslationBlock) => saveSkip(runtime, block),
    scopeValue: (scope: string) => scopeValue(runtime, scope),
  };
  runtime.ui = createToolbar(runtime);
  const detachSelection = attachSelectionMenu(runtime);

  function onMessage(incoming: unknown, _sender: chrome.runtime.MessageSender, respond: (response: { ok: boolean } & Partial<ContentStatus>) => void): void {
    if (!incoming || typeof incoming !== 'object') return;
    const message = incoming as ContentPush;
    if (message.type === MESSAGE_TYPES.GET_CONTENT_STATUS) {
      respond({ ok: true, ...getStatus(state) });
    } else if (message.type === MESSAGE_TYPES.START_TRANSLATION) {
      if (message.mode) runtime.setMode(message.mode);
      runtime.startTranslation();
      respond({ ok: true });
    } else if (message.type === MESSAGE_TYPES.STOP_TRANSLATION) {
      runtime.stopTranslation();
      respond({ ok: true });
    } else if (message.type === MESSAGE_TYPES.SET_DISPLAY_MODE) {
      runtime.setMode(message.mode);
      respond({ ok: true });
    } else if (message.type === MESSAGE_TYPES.RULES_CHANGED) {
      if (isActive(state.run)) runtime.stopTranslation();
      state.analysisNote = '';
      runtime.markStale();
      const runState = state.run;
      send(MESSAGE_TYPES.GET_CONTEXT, {}).then(context => {
        if (state.run !== runState || runtime.scopeValue('page') !== state.pageUrl || !runtime.ui.host.isConnected) return;
        state.context = context;
        runtime.render();
      }).catch(error => { if (state.run === runState && runtime.ui.host.isConnected) runtime.showError(error); });
      respond({ ok: true });
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  const initialRunState = state.run;
  send(MESSAGE_TYPES.GET_CONTEXT, {}).then(context => {
    if (state.run !== initialRunState || runtime.scopeValue('page') !== state.pageUrl || !runtime.ui.host.isConnected) return;
    state.context = context;
    runtime.setMode(context.settings?.mode || 'dual');
    if (!state.blocks.length) scanBlocks(state);
    runtime.render();
  }).catch(error => { if (state.run === initialRunState && runtime.ui.host.isConnected) runtime.showError(error); });
  runtime.setMode('dual');
})();
