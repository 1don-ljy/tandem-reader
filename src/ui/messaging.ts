import { send as sendToBackground, type RequestInput, type RequestOutput, type RequestType } from '../shared/protocol.ts';

/**
 * UI (popup / settings) entry point for the shared typed transport. It only
 * supplies the wording this surface shows when a background response is unusable.
 */
export function send<K extends RequestType>(type: K, payload: RequestInput<K>): Promise<RequestOutput<K>> {
  return sendToBackground(type, payload, '操作未完成，请重试。');
}
