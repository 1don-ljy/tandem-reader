import type { ContentStatus } from '../shared/types.ts';
import { CANDIDATES, EXCLUDED, isVisible, normalize, readableRoot, textWithCode } from './dom.ts';
import type { ReadingState, TranslationBlock } from './state.ts';

import { isActive } from './state.ts';

export function getStatus(state: ReadingState): ContentStatus {
  const blocks = state.blocks.filter(block => isReadableBlock(block, state));
  return {
    running: isActive(state.run),
    total: blocks.length,
    done: blocks.filter(block => block.status === 'done').length,
    failed: blocks.filter(block => block.status === 'error').length,
    mode: state.mode,
  };
}

export function scanBlocks(state: ReadingState): void {
  const root = readableRoot();
  const existing = new Set(state.blocks.map(block => block.node));
  const nodes = [...root.querySelectorAll<HTMLElement>(CANDIDATES)].filter(node =>
    isVisible(node) && !existing.has(node) && !node.hasAttribute('data-docling-source') && !node.closest('[data-docling-source]') &&
    !state.blocks.some(block => node.contains(block.node) || block.node.contains(node))
  );
  const leaves = nodes.filter(node => !nodes.some(other => other !== node && node.contains(other)));
  const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(node => !node.closest('.docling-translation'));
  for (const node of leaves) {
    const extracted = textWithCode(node);
    const originalText = normalize(extracted.text.replace(/\[\[DOC_CODE_(\d+)\]\]/g, (marker: string, index: string) => extracted.codes[Number(index)]?.text ?? marker));
    const precedingHeading = headings.filter(item => item === node || Boolean(item.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
    const heading = precedingHeading ? state.blocks.find(block => block.node === precedingHeading)?.originalText || normalize(precedingHeading.innerText) : document.title;
    if (!/[A-Za-z]{2,}/.test(extracted.text.replace(/\[\[DOC_CODE_\d+\]\]/g, '')) || originalText.length < 3) continue;
    if (node.closest('a') || node.querySelector('pre, button, input, textarea, select, [contenteditable]:not([contenteditable="false"])')) continue;
    const skip = state.context?.skips?.find(item => normalize(item.text) === originalText);
    const block: TranslationBlock = { node, source: node, wrapper: null, output: null, originalText, text: extracted.text, codes: extracted.codes, heading, status: 'pending', skip: skip || null };
    state.blocks.push(block);
  }
  state.blocks.sort((a, b) => a.node === b.node ? 0 : a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
}

export function isReadableBlock(block: TranslationBlock, state: ReadingState): boolean {
  if (block.skip || !block.node.isConnected || block.node.closest(EXCLUDED)) return false;
  if (isVisible(block.node)) return true;
  if (state.mode !== 'translation' || block.source.dataset.doclingSource !== 'true' || block.source.dataset.doclingReveal === 'true' || !block.output) return false;
  const style = getComputedStyle(block.output);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && block.output.getClientRects().length > 0;
}

export function documentAnalysisSample(state: ReadingState): { documentTitle: string; headings: string[]; sample: string } {
  const blocks = state.blocks.filter(block => isReadableBlock(block, state));
  const headingTexts = [...readableRoot().querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].flatMap(node => {
    const block = state.blocks.find(item => item.node === node);
    if (block) return isReadableBlock(block, state) ? [block.originalText] : [];
    if (!isVisible(node)) return [];
    const text = normalize(node.innerText);
    return state.context?.skips.some(skip => normalize(skip.text) === text) ? [] : [text];
  });
  const headings = [...new Set(headingTexts.filter(Boolean))].slice(0, 30).map(heading => heading.slice(0, 200));
  const text = blocks.map(block => normalize(block.text.replace(/\[\[DOC_CODE_(\d+)\]\]/g, (_marker: string, index: string) => {
    const fragment = block.codes[Number(index)];
    if (!fragment || fragment.type === 'text' || fragment.text.length > 200 || fragment.text.split('\n').length > 3) return ' ';
    return fragment.text;
  }))).filter(Boolean).join('\n\n');
  if (text.length <= 12000) return { documentTitle: document.title.slice(0, 500), headings, sample: text };
  const segmentLength = 3998;
  const middle = Math.floor((text.length - segmentLength) / 2);
  return {
    documentTitle: document.title.slice(0, 500),
    headings,
    sample: `${text.slice(0, segmentLength)}\n\n${text.slice(middle, middle + segmentLength)}\n\n${text.slice(-segmentLength)}`,
  };
}
