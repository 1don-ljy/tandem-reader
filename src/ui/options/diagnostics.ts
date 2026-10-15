import type { DiagnosticEvent, DiagnosticSnapshot } from '../../shared/diagnostics.ts';
import { MESSAGE_TYPES } from '../../shared/protocol.ts';
import { $, downloadJson, element, notice } from '../dom.ts';
import { send } from '../messaging.ts';

let snapshot: DiagnosticSnapshot | undefined;

function describe(event: DiagnosticEvent): string {
  const parts = [new Date(event.at).toLocaleString(), event.type, event.phase];
  if (event.tabId !== undefined) parts.push(`标签页 ${event.tabId}`);
  if (event.jobId) parts.push(event.jobId);
  if (event.durationMs !== undefined) parts.push(`${event.durationMs} ms`);
  if (event.errorCode) parts.push(event.errorCode);
  return parts.join(' · ');
}

export function renderDiagnostics(): void {
  const list = $('diagnostics-events');
  list.replaceChildren();
  $('diagnostic-count').textContent = String(snapshot?.events.length ?? 0);
  if (!snapshot) {
    list.append(element('p', 'field-hint', '点击“查看诊断”读取最近的模型请求与失败记录。'));
    return;
  }
  if (!snapshot.events.length) {
    list.append(element('p', 'field-hint', '还没有记录。开始翻译后，这里会显示模型请求与失败事件。'));
    return;
  }
  for (const event of [...snapshot.events].reverse()) list.append(element('p', 'rule-details', describe(event)));
}

async function load(): Promise<void> {
  snapshot = await send(MESSAGE_TYPES.GET_DIAGNOSTICS, {});
  renderDiagnostics();
}

export function bindDiagnostics(): void {
  $('load-diagnostics').addEventListener('click', async () => {
    try {
      await load();
      notice(`已读取 ${snapshot?.events.length ?? 0} 条诊断记录。`);
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
  });
  $('export-diagnostics').addEventListener('click', async () => {
    try {
      await load();
      downloadJson(`tandem-reader-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, snapshot);
      notice('诊断记录已导出，文件不包含页面文本、译文与 API Key。');
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
  });
  renderDiagnostics();
}
