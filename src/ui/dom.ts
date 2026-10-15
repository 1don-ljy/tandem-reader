type InputId = 'profile-id' | 'profile-name' | 'profile-base-url' | 'profile-model' | 'profile-key' | 'rule-id' | 'rule-term' | 'rule-translation' | 'rule-scope-value' | 'rule-domain' | 'rule-search' | 'import-file' | 'memory-id' | 'memory-scope-value' | 'memory-domain';
type SelectId = 'profile-provider' | 'key-persistence' | 'rule-action' | 'rule-scope' | 'memory-scope';
type ButtonId = 'new-profile' | 'test-profile' | 'save-profile' | 'new-rule' | 'cancel-rule' | 'save-rule' | 'export-config' | 'import-config' | 'new-memory' | 'save-memory' | 'cancel-memory' | 'clear-sessions' | 'load-diagnostics' | 'export-diagnostics';
type OtherId = 'notice' | 'profiles' | 'key-storage-hint' | 'profile-form-title' | 'key-state' | 'connection-result' | 'translation-field' | 'scope-url-field' | 'scope-domain-field' | 'scope-url-label' | 'scope-hint' | 'rule-form-title' | 'rules' | 'skip-count' | 'skips' | 'memories' | 'memory-form-title' | 'memory-scope-label' | 'memory-scope-hint' | 'sessions' | 'session-count' | 'profile-endpoint-hint' | 'profile-model-hint' | 'profile-key-hint' | 'domain-memories' | 'domain-memory-count' | 'diagnostic-count' | 'diagnostics-events';
export type OptionsElements = Record<InputId, HTMLInputElement> & Record<SelectId, HTMLSelectElement> & Record<ButtonId, HTMLButtonElement>
  & Record<OtherId, HTMLElement> & Record<'profile-form' | 'rule-form' | 'memory-form', HTMLFormElement>
  & { 'memory-context': HTMLTextAreaElement; 'provider-docs': HTMLAnchorElement; 'provider-models': HTMLDataListElement };

export const $ = <K extends keyof OptionsElements>(id: K): OptionsElements[K] => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少界面元素：${id}`);
  return node as OptionsElements[K];
};

export const actionLabels = { keep: '保留原文', translate: '指定译法', first: '首次中英对照' };
export const scopeLabels = { page: '当前页面', collection: '这套文档', domain: '领域', global: '所有文档' };

export function notice(message: string, isError = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', isError);
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function actionButton(label: string, className: string, action: () => void | Promise<void>) {
  const button = element('button', className, label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
    finally { button.disabled = false; }
  });
  return button;
}

/** Saves `value` as a pretty-printed JSON download without touching the network. */
export function downloadJson(filename: string, value: unknown): void {
  const blobUrl = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
