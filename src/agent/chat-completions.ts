import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { contentText, getSystemMessageText } from '@earendil-works/pi-ai/utils/text';
import type { ChatMessage, Connection } from '../shared/types.ts';
import { providerRequestOptions, resolveProvider } from '../shared/providers.ts';

interface CompletionResponse {
  choices?: {
    message?: { content?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: unknown;
  }[];
}

export function createChatCompletionsStream(connection: Connection): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending',
      timestamp: Date.now(),
    };

    void (async () => {
      try {
        if (options?.signal?.aborted) throw new Error('翻译已停止。');
        const messages: ChatMessage[] = [];
        for (const message of context.messages) {
          if (message.role === 'system') {
            messages.push({ role: 'system', content: getSystemMessageText(message) });
          } else if (message.role === 'user' || message.role === 'assistant') {
            messages.push({ role: message.role, content: contentText(message.content) });
          }
        }
        const response = await fetch(connection.endpoint, {
          method: 'POST', redirect: 'error', signal: options?.signal,
          headers: { 'Content-Type': 'application/json', ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}) },
          body: JSON.stringify({ model: connection.profile.model, messages, stream: false, ...providerRequestOptions(resolveProvider(connection.profile.provider, connection.baseUrl), connection.profile.model) }),
        });
        if (!response.ok) {
          if ([401, 403].includes(response.status)) throw new Error('接口拒绝访问，请检查 Key、模型权限和接口地址。');
          if (response.status === 429) throw new Error('接口限流或额度不足，请稍后重试或检查服务商额度。');
          if (response.status === 404) throw new Error('找不到接口或模型。Base URL 应填写 /chat/completions 之前的地址。');
          throw new Error(`模型服务返回 HTTP ${response.status}，请检查服务状态后重试。`);
        }
        const raw = await response.text();
        if (raw.length > 250000) throw new Error('模型响应过大，请缩短段落或更换模型。');
        let result: CompletionResponse | null;
        try { result = JSON.parse(raw) as CompletionResponse | null; }
        catch { throw new Error('接口没有返回兼容的 JSON 响应。'); }
        const choice = result?.choices?.[0];
        const content = choice?.message?.content;
        if (choice?.finish_reason === 'length') throw new Error('模型输出被截断，请缩短段落或调整模型。');
        const toolCalls = choice?.message?.tool_calls;
        if ((choice?.finish_reason != null && choice.finish_reason !== 'stop') ||
            (toolCalls != null && (!Array.isArray(toolCalls) || toolCalls.length > 0)) ||
            choice?.message?.function_call != null) {
          throw new Error('模型没有完成文本翻译，请检查模型兼容性。');
        }
        if (typeof content !== 'string' || !content.trim()) throw new Error('接口未返回 choices[0].message.content 文本，请检查协议与模型。');
        if (options?.signal?.aborted) throw new Error('翻译已停止。');

        stream.push({ type: 'start', partial: output });
        const text = { type: 'text' as const, text: '' };
        output.content.push(text);
        stream.push({ type: 'text_start', contentIndex: 0, partial: output });
        text.text = content.trim();
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text.text, partial: output });
        stream.push({ type: 'text_end', contentIndex: 0, content: text.text, partial: output });
        output.stopReason = 'stop';
        stream.push({ type: 'done', reason: 'stop', message: output });
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = options?.signal?.aborted
          ? '翻译已停止或规则已更新。'
          : error instanceof TypeError
            ? '无法连接模型接口，请检查网址、网络、访问授权和服务是否运行。'
            : error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: output.stopReason, error: output });
      } finally {
        stream.end(output);
      }
    })();
    return stream;
  };
}
