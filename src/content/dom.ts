export type CodeFragment =
  | { type: 'code' | 'text'; text: string }
  | { type: 'link'; text: string; href: string; newTab: boolean };

export const CANDIDATES = 'p, h1, h2, h3, h4, h5, h6, li, td, th, figcaption, blockquote';
export const EXCLUDED = 'nav, header, footer, aside, form, pre, code, script, style, noscript, textarea, input, select, button, svg, canvas, [contenteditable]:not([contenteditable="false"]), [hidden], [aria-hidden="true"], [translate="no"], .notranslate, [role="navigation"], [role="menu"], .docling-translation, [data-docling-ui]';

export function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text?: string, className?: string): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function button(text: string, action: (event: MouseEvent) => void | Promise<void>, className?: string): HTMLButtonElement {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function readableRoot(): HTMLElement {
  const roots = [...document.querySelectorAll<HTMLElement>('article, main, [role="main"], .markdown-body, .theme-doc-markdown, .md-content__inner')];
  return roots.sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;
}

export function isVisible(node: HTMLElement): boolean {
  if (!node.isConnected || node.closest(EXCLUDED)) return false;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
}

export function textWithCode(node: HTMLElement): { text: string; codes: CodeFragment[] } {
  const codes: CodeFragment[] = [];
  function visit(current: Node): string {
    if (current.nodeType === Node.TEXT_NODE) return current.textContent || '';
    if (!(current instanceof Element)) return '';
    if (current.matches('.docling-translation, [data-docling-ui], script, style, button, input, select, textarea, [hidden], [aria-hidden="true"]')) return '';
    const visibility = getComputedStyle(current);
    if (visibility.display === 'none' || visibility.visibility === 'hidden' || visibility.visibility === 'collapse') return '';
    if (current.matches('code, kbd, samp, var, a[href], [translate="no"], .notranslate')) {
      const marker = `[[DOC_CODE_${codes.length}]]`;
      let fragment: CodeFragment = { text: current.textContent || '', type: current.matches('code, kbd, samp, var') ? 'code' : 'text' };
      if (current.matches('a[href]')) {
        try {
          const url = new URL(current.getAttribute('href') || '', location.href);
          if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
            fragment = { type: 'link', text: current.textContent || '', href: url.href, newTab: current.getAttribute('target') === '_blank' };
          }
        } catch { /* An invalid link remains readable text. */ }
      }
      codes.push(fragment);
      return marker;
    }
    if (current.tagName === 'BR') return '\n';
    return [...current.childNodes].map(visit).join('');
  }
  return { text: visit(node).trim(), codes };
}

export function restoreCode(text: string, codes: CodeFragment[]): HTMLSpanElement {
  const result = element('span');
  const marker = /\[\[DOC_CODE_(\d+)\]\]/g;
  let offset = 0;
  for (const match of text.matchAll(marker)) {
    result.append(document.createTextNode(text.slice(offset, match.index)));
    const fragment = codes[Number(match[1])];
    if (!fragment) result.append(document.createTextNode(match[0]));
    else if (fragment.type === 'code') result.append(element('code', fragment.text));
    else if (fragment.type === 'link') {
      const link = element('a', fragment.text);
      link.href = fragment.href;
      if (fragment.newTab) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      result.append(link);
    } else result.append(document.createTextNode(fragment.text));
    offset = match.index + match[0].length;
  }
  result.append(document.createTextNode(text.slice(offset)));
  return result;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
