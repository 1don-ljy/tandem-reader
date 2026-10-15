import { classifyError } from '../shared/diagnostics.ts';
import { MESSAGE_TYPES, type RequestMessage } from '../shared/protocol.ts';
import { handle } from './router.ts';
import { abortJobsForTab, diagnostics } from './store.ts';

/** Requests that talk to a model; they get a `start` event so an unfinished call stays visible. */
const MODEL_REQUESTS: readonly string[] = [MESSAGE_TYPES.TRANSLATE, MESSAGE_TYPES.ANALYZE_DOCUMENT, MESSAGE_TYPES.EXPLAIN];

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') {
    respond({ ok: false, error: '请求格式无效。' }); return false;
  }
  const request = message as RequestMessage;
  const startedAt = Date.now();
  const tabId = sender.tab?.id;
  const jobId = 'jobId' in request && typeof request.jobId === 'string' ? request.jobId : undefined;
  if (MODEL_REQUESTS.includes(request.type)) {
    diagnostics.record({ at: startedAt, type: request.type, tabId, jobId, phase: 'start', ok: true });
  }
  handle(request, sender).then(data => {
    diagnostics.record({ at: startedAt, type: request.type, tabId, jobId, phase: 'done', durationMs: Date.now() - startedAt, ok: true });
    respond({ ok: true, ...data });
  }, (error: unknown) => {
    diagnostics.record({ at: startedAt, type: request.type, tabId, jobId, phase: 'error', durationMs: Date.now() - startedAt, ok: false, errorCode: classifyError(error) });
    respond({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' });
  });
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  abortJobsForTab(tabId);
  chrome.storage.session.get(null).then(data => chrome.storage.session.remove(Object.keys(data).filter(key => key === `allowed:${tabId}` || key === `context:${tabId}` || key.startsWith(`job:${tabId}:`)))).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url && change.status !== 'loading') return;
  abortJobsForTab(tabId);
});
