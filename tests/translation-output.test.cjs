const { test } = require('node:test');
const assert = require('node:assert/strict');

const outputModule = import('../src/shared/translation-output.ts');
const core = import('../src/shared/core.ts');

test('screenshot JSON envelope displays only the translated paragraph', async () => {
  const { normalizeTranslationOutput, FORMAT_VERSION } = await outputModule;
  const screenshot = '{"documentTitle":"02 工具审批 human in loop · Microsoft Agent Framework —— 从入门到进阶","section":"MAF 中的工具审批","text":"MAF 中的工具审批"}';
  assert.equal(normalizeTranslationOutput(screenshot, 'Tool Approval in MAF'), 'MAF 中的工具审批');
  assert.equal(typeof FORMAT_VERSION, 'string');
  assert.ok(FORMAT_VERSION.length > 0);
});

test('known output envelopes decode quotes and newlines, including whole JSON fences', async () => {
  const { normalizeTranslationOutput } = await outputModule;
  const translated = '他说："使用 agent"。\n下一行保持原样。';
  for (const field of ['text', 'translation', 'translatedText']) {
    const json = JSON.stringify({ documentTitle: 'Reference title', section: 'Reference chapter', [field]: translated });
    assert.equal(normalizeTranslationOutput(json, 'He said: "Use an agent."\nNext line.'), translated);
    assert.equal(normalizeTranslationOutput(`\`\`\`json\n${json}\n\`\`\``, 'Translate this paragraph.'), translated);
  }
});

test('unwrapping precedes term validation and cannot hide missing protected tokens', async () => {
  const { normalizeTranslationOutput } = await outputModule;
  const { protectTerms, restoreTerms } = await core;
  const data = protectTerms('The agent uses [[DOC_CODE_0]].', [{ id: 'agent', term: 'agent', action: 'keep', translation: '', scope: 'global', scopeValue: '' }], [], 'wrapper');
  const translated = `该 ${data.replacements[0].token} 使用 [[DOC_CODE_0]]。`;
  assert.equal(restoreTerms(normalizeTranslationOutput(JSON.stringify({ text: translated }), data.text), data), '该 agent 使用 [[DOC_CODE_0]]。');
  const missing = JSON.stringify({ documentTitle: data.replacements[0].token, text: '该代理使用 [[DOC_CODE_0]]。' });
  assert.throws(() => restoreTerms(normalizeTranslationOutput(missing, data.text), data), /未完整保留/);
});

test('genuine JSON source examples retain their entire translated JSON structure', async () => {
  const { normalizeTranslationOutput } = await outputModule;
  for (const [source, result] of [
    ['{"documentTitle":"Example","section":"Sample","text":"Hello"}', '{"documentTitle":"示例","section":"样本","text":"你好"}'],
    ['{"text":"Hello"}', '{"text":"你好"}'],
    ['[{"text":"Hello"}]', '[{"text":"你好"}]'],
    ['```json\n{"text":"Hello"}\n```', '```json\n{"text":"你好"}\n```']
  ]) assert.equal(normalizeTranslationOutput(result, source), result);
});

test('plain translation and document Markdown are preserved without broad stripping', async () => {
  const { normalizeTranslationOutput } = await outputModule;
  for (const result of ['普通译文。', '**强调内容**\n- 第一个项目', '示例：{"text":"你好"}', '```csharp\nvar agent = new Agent();\n```']) {
    assert.equal(normalizeTranslationOutput(result, 'A technical document example.'), result);
  }
});

test('empty, ambiguous, malformed and unknown envelopes fail instead of becoming visible JSON', async () => {
  const { normalizeTranslationOutput } = await outputModule;
  for (const result of ['', '{"text":""}', '{"translation":"   "}', '{"text":null}', '{"text":"一","translation":"二"}', '{"documentTitle":"Title","text":"unfinished}', '{"answer":"unexpected wrapper"}']) {
    assert.throws(() => normalizeTranslationOutput(result, 'A normal source paragraph.'), /译文|格式|文本|输出/);
  }
});
