import { MESSAGE_TYPES } from '../../shared/protocol.ts';
import type { OptionsRuntime } from '../context.ts';
import { $, actionButton, element, downloadJson, notice } from '../dom.ts';
import { send } from '../messaging.ts';
import { resetMemory } from './memory.ts';
import { resetProfile } from './models.ts';
import { resetRule } from './terms.ts';

export function renderSkips(runtime: OptionsRuntime) {
  $('skip-count').textContent = String(runtime.state.skips.length);
  $('skips').replaceChildren();
  if (!runtime.state.skips.length) $('skips').append(element('p', 'field-hint', '尚未标记不翻译的段落。'));
  for (const skip of runtime.state.skips) {
    const row = element('article', 'rule-row');
    row.append(element('p', 'skip-text', skip.text), element('p', 'rule-details', skip.url));
    row.append(actionButton('取消不翻译标记', 'text-button', async () => {
      await send(MESSAGE_TYPES.DELETE_SKIP, { id: skip.id });
      await runtime.reloadState();
      notice('已取消标记。重新翻译原页面时会处理这一段。');
    }));
    $('skips').append(row);
  }
}

export function renderSessions(runtime: OptionsRuntime) {
  $('session-count').textContent = String(runtime.state.sessions.length);
  $('clear-sessions').disabled = runtime.state.sessions.length === 0;
  $('sessions').replaceChildren();
  if (!runtime.state.sessions.length) $('sessions').append(element('p', 'field-hint', '尚未保存近期文档会话。'));
  for (const session of runtime.state.sessions) {
    const row = element('article', 'rule-row');
    row.append(element('p', 'rule-details', session.url), element('p', 'field-hint', `已记住 ${session.turnCount} 段近期上下文`));
    $('sessions').append(row);
  }
}

export function bindData(runtime: OptionsRuntime): void {
  $('clear-sessions').addEventListener('click', async () => {
    $('clear-sessions').disabled = true;
    try {
      await send(MESSAGE_TYPES.CLEAR_SESSIONS, {});
      await runtime.reloadState();
      notice('近期文档会话已清除。你保存的领域记忆和术语规则仍可使用。');
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
    finally { $('clear-sessions').disabled = runtime.state.sessions.length === 0; }
  });

  $('export-config').addEventListener('click', async () => {
    try {
      const { config } = await send(MESSAGE_TYPES.EXPORT_CONFIG, {});
      downloadJson(`tandem-reader-config-${new Date().toISOString().slice(0, 10)}.json`, config);
      notice('配置已导出，文件不包含 API Key。');
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
  });
  $('import-config').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const file = $('import-file').files?.[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('配置文件过大，请选择 5 MB 以内的 JSON 文件。');
      let config: unknown;
      try { config = JSON.parse(await file.text()); } catch { throw new Error('无法读取配置，请选择有效的 JSON 文件。'); }
      if (!confirm('导入会替换当前偏好、术语、模型配置与人工领域记忆。已导出的备份不含 Key，导入后可能需要重新填写。继续导入？')) return;
      await send(MESSAGE_TYPES.IMPORT_CONFIG, { config });
      await runtime.reloadState();
      resetProfile(runtime);
      resetRule();
      resetMemory();
      notice('配置已导入。请检查模型地址，按需重新填写 Key 并测试连接。');
    } catch (error) { notice(error instanceof Error ? error.message : '操作未完成，请重试。', true); }
    finally { $('import-file').value = ''; }
  });
}
