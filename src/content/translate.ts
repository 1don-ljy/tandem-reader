import { MESSAGE_TYPES, send } from '../shared/protocol.ts';
import type { ContentRuntime } from './context.ts';
import { button, element, errorMessage, normalize, restoreCode } from './dom.ts';
import { renderBlock } from './render.ts';
import { documentAnalysisSample, getStatus, isReadableBlock, scanBlocks } from './scan.ts';
import { currentRun, isActive, isSameRun, newRunToken, type RunToken, type TranslationBlock } from './state.ts';

export function prepareBlock(runtime: ContentRuntime, block: TranslationBlock): HTMLDivElement {
  if (block.output) return block.output;
  if (['LI', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION'].includes(block.node.tagName)) {
    const wrapper = element('span');
    wrapper.dataset.doclingWrapper = 'true';
    while (block.node.firstChild) wrapper.append(block.node.firstChild);
    block.node.append(wrapper);
    block.wrapper = wrapper;
    block.source = wrapper;
  }
  block.source.dataset.doclingSource = 'true';
  block.source.dataset.doclingReveal = 'true';
  block.output = element('div', undefined, 'docling-translation');
  const language = runtime.state.context?.settings?.targetLanguage || 'zh-CN';
  if (/中文/.test(language)) block.output.setAttribute('lang', 'zh-CN');
  else if (/^[a-z]{2,3}(?:-[a-zA-Z]{2,8})*$/.test(language)) block.output.setAttribute('lang', language);
  block.output.setAttribute('aria-label', 'Tandem Reader 译文');
  block.output.dataset.doclingState = 'pending';
  if (block.wrapper) block.node.append(block.output);
  else block.node.after(block.output);
  return block.output;
}

export function outputTools(runtime: ContentRuntime, block: TranslationBlock): HTMLSpanElement {
  const controls = element('span');
  controls.dataset.doclingNote = 'true';
  const reveal = button('查看原文', () => {
    const visible = block.source.dataset.doclingReveal === 'true';
    block.source.dataset.doclingReveal = String(!visible);
    reveal.textContent = visible ? '查看原文' : '收起原文';
  });
  reveal.title = '译文模式下临时展开本段原文';
  reveal.dataset.doclingRevealButton = 'true';
  reveal.hidden = runtime.state.mode !== 'translation';
  controls.append(reveal, button('不翻译这段', () => runtime.saveSkip(block)));
  return controls;
}

export function removeBlockTranslation(block: TranslationBlock): void {
  block.output?.remove();
  block.output = null;
  delete block.source.dataset.doclingSource;
  delete block.source.dataset.doclingReveal;
  if (block.wrapper) {
    while (block.wrapper.firstChild) block.wrapper.before(block.wrapper.firstChild);
    block.wrapper.remove();
    block.wrapper = null;
    block.source = block.node;
  }
  block.status = 'pending';
}

export function markStale(runtime: ContentRuntime): void {
  const { state } = runtime;
  state.stale = true;
  for (const block of state.blocks) {
    if (block.status !== 'done' || !block.output) continue;
    block.output.dataset.doclingState = 'stale';
    if (!block.output.querySelector('[data-docling-stale]')) {
      const note = element('span', '术语规则已变更 · 点击阅读工具中的“更新译文”应用新规则');
      note.dataset.doclingNote = 'true';
      note.dataset.doclingStale = 'true';
      block.output.append(note);
    }
  }
  runtime.render();
}

export async function translateBlock(runtime: ContentRuntime, block: TranslationBlock, run: RunToken): Promise<void> {
  prepareBlock(runtime, block);
  block.status = 'pending';
  renderBlock(block, [element('span', '正在翻译…')]);
  try {
    const response = await send(MESSAGE_TYPES.TRANSLATE, {
      text: block.text,
      plainText: block.originalText,
      codeTexts: block.codes.map(fragment => fragment.text),
      heading: block.heading,
      documentTitle: document.title,
      jobId: run.jobId,
      seenTerms: priorFirstTerms(runtime, block),
    });
    if (!isCurrentRun(runtime, run) || !block.node.isConnected || block.skip) return;
    if (typeof response.text !== 'string' || !response.text.trim()) throw new Error('模型没有返回译文，请重试。');
    const missing = block.codes.some((_, index) => !response.text.includes(`[[DOC_CODE_${index}]]`));
    if (missing) throw new Error('模型遗漏了代码标记，已保留原文。请重试或更换模型。');
    block.status = 'done';
    renderBlock(block, [restoreCode(response.text, block.codes), outputTools(runtime, block)]);
  } catch (error) {
    if (!isCurrentRun(runtime, run) || block.skip) return;
    block.status = 'error';
    renderBlock(block, [element('span', `翻译失败：${errorMessage(error)}`), button('重试本段', () => runtime.retryBlock(block))]);
  }
  runtime.render();
}

export function priorFirstTerms(runtime: ContentRuntime, block: TranslationBlock): string[] {
  const { state } = runtime;
  const preceding = state.blocks.slice(0, state.blocks.indexOf(block))
    .filter(item => !item.skip && item.node.isConnected)
    .map(item => item.text.replace(/\[\[DOC_CODE_\d+\]\]/g, ' ')).join('\n');
  const word = /[\p{L}\p{N}_]/u;
  return (state.context?.rules || []).filter(rule => {
    if (rule.action !== 'first') return false;
    const escaped = rule.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'giu');
    for (const match of preceding.matchAll(pattern)) {
      const before = preceding[match.index - 1] || '';
      const after = preceding[match.index + match[0].length] || '';
      if ((!word.test(match[0][0] || '') || !word.test(before)) && (!word.test(match[0].at(-1) || '') || !word.test(after))) return true;
    }
    return false;
  }).map(rule => rule.id);
}

export function scopeValue(runtime: ContentRuntime, scope: string): string {
  const url = new URL(location.href);
  url.hash = '';
  if (scope === 'page') return url.href;
  if (scope === 'collection') return `${url.origin}${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}`;
  if (scope === 'domain') return runtime.state.context?.settings?.domain || '通用技术文档';
  return '*';
}

export function isCurrentRun(runtime: ContentRuntime, run: RunToken): boolean {
  const { state } = runtime;
  if (!isSameRun(state, run)) return false;
  if (scopeValue(runtime, 'page') === state.pageUrl) return true;
  stopTranslation(runtime);
  state.message = '页面已变化，请重新开始翻译。';
  runtime.render();
  return false;
}

export async function analyzeDocument(runtime: ContentRuntime, run: RunToken): Promise<boolean> {
  const { state } = runtime;
  if (!state.context || state.context.settings.autoDiscover === false) return false;
  const sample = documentAnalysisSample(state);
  if (!sample.sample) return false;
  const previousContext = JSON.stringify([state.context.settings.domain, state.context.settings.context, state.context.rules]);
  let changed = false;
  state.run = { kind: 'analyzing', run };
  state.message = '正在分析文档领域与术语，完成后开始翻译…';
  runtime.render();
  try {
    const response = await send(MESSAGE_TYPES.ANALYZE_DOCUMENT, { jobId: run.jobId, ...sample });
    if (!isCurrentRun(runtime, run)) return false;
    state.context = response.context;
    state.analysisNote = response.warning
      ? `分析未完成，使用当前配置翻译：${response.warning.slice(0, 300)}`
      : `${response.reused ? '已复用领域记忆' : '已自动识别'}，${response.context.domainMemory?.terms.length || 0} 个术语`;
    const nextContext = JSON.stringify([response.context.settings.domain, response.context.settings.context, response.context.rules]);
    changed = nextContext !== previousContext;
  } catch (error) {
    if (!isCurrentRun(runtime, run)) return false;
    throw error;
  }
  runtime.render();
  return changed;
}

export async function startTranslation(runtime: ContentRuntime, force = false): Promise<void> {
  const { state } = runtime;
  if (isActive(state.run)) return;
  const pageUrl = scopeValue(runtime, 'page');
  if (pageUrl !== state.pageUrl) {
    for (const block of state.blocks) removeBlockTranslation(block);
    state.blocks = [];
    state.context = null;
    state.selection = null;
    state.stale = false;
    state.pageUrl = pageUrl;
    runtime.ui.menu.hidden = true;
  }
  force = force || state.stale;
  const run = newRunToken(`docling-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  state.run = { kind: 'loading', run };
  state.analysisNote = '';
  state.message = '正在读取模型与术语配置…';
  runtime.render();
  try {
    const context = await send(MESSAGE_TYPES.GET_CONTEXT, {});
    if (!isCurrentRun(runtime, run)) return;
    state.context = context;
    if (!state.context.profileConfigured) {
      state.message = '请先打开设置，配置模型、接口地址和 API Key。';
      return;
    }
    scanBlocks(state);
    for (const block of state.blocks) {
      block.skip = state.context.skips?.find(item => normalize(item.text) === block.originalText) || null;
      if (block.skip) removeBlockTranslation(block);
    }
    if (state.blocks.some(block => (force || block.status !== 'done') && isReadableBlock(block, state))) {
      force = await analyzeDocument(runtime, run) || force;
    }
    if (!isCurrentRun(runtime, run)) return;
    if (force) for (const block of state.blocks) if (isReadableBlock(block, state)) block.status = 'pending';
    state.run = { kind: 'translating', run };
    state.stale = false;
    runtime.render();
    for (const block of state.blocks) {
      if (!isCurrentRun(runtime, run) || !isActive(state.run)) break;
      if (block.status === 'done' || !isReadableBlock(block, state)) continue;
      await translateBlock(runtime, block, run);
    }
    if (isSameRun(state, run)) {
      const status = getStatus(state);
      state.message = status.total
        ? `已完成 ${status.done} / ${status.total} 段${status.failed ? `，${status.failed} 段可单独重试` : '。选中原文即可标记术语。'}`
        : '没有找到需要翻译的英文正文。代码与已跳过的段落保留原样。';
    }
  } catch (error) {
    if (isSameRun(state, run)) {
      state.run = { kind: 'error', run, message: errorMessage(error) };
      state.message = errorMessage(error);
    }
  }
  finally {
    if (isSameRun(state, run)) {
      if (isActive(state.run)) state.run = { kind: 'idle' };
      runtime.render();
    }
  }
}

export async function retryBlock(runtime: ContentRuntime, block: TranslationBlock): Promise<void> {
  const { state } = runtime;
  if (isActive(state.run)) {
    runtime.showToast('请等待当前翻译完成，或先停止后重试。');
    return;
  }
  const run = newRunToken(`docling-retry-${Date.now()}`);
  state.run = { kind: 'translating', run };
  runtime.render();
  await translateBlock(runtime, block, run);
  if (isSameRun(state, run)) {
    state.run = { kind: 'idle' };
    state.message = block.status === 'done' ? '本段译文已更新。' : '本段仍未翻译成功，请检查模型配置后重试。';
  }
  runtime.render();
}

export function stopTranslation(runtime: ContentRuntime): void {
  const { state } = runtime;
  const run = currentRun(state.run);
  if (run?.jobId) send(MESSAGE_TYPES.CANCEL, { jobId: run.jobId }).catch(() => {});
  state.run = { kind: 'stopped', run: newRunToken(run?.jobId || '') };
  state.message = '已停止。完成的译文仍然保留。';
  for (const block of state.blocks) {
    if (block.output && block.status === 'pending') {
      if (block.output.dataset.doclingState === 'done' || block.output.dataset.doclingState === 'stale') {
        block.status = 'done';
        state.stale = true;
        continue;
      }
      renderBlock(block, [element('span', '翻译已停止。'), button('重试本段', () => runtime.retryBlock(block))]);
    }
  }
  runtime.render();
}

export async function saveSkip(runtime: ContentRuntime, block: TranslationBlock): Promise<void> {
  try {
    const response = await send(MESSAGE_TYPES.SAVE_SKIP, { text: block.originalText });
    block.skip = response.skip;
    removeBlockTranslation(block);
    runtime.ui.menu.hidden = true;
    runtime.showToast('这一段将保持原文。', async () => {
      await send(MESSAGE_TYPES.DELETE_SKIP, { id: response.skip.id });
      block.skip = null;
      runtime.render();
    });
    runtime.render();
  } catch (error) { runtime.showError(error); }
}
