import type {
  ContentStatus, DisplayMode, DocumentMemory, DomainMemory, ExportedConfig, MemoryInput,
  PageContext, ProfileInput, PublicState, Rule, RuleInput, Settings, Skip,
} from './types.ts';
import type { DiagnosticSnapshot } from './diagnostics.ts';

export interface ActivePage {
  url: string;
  collectionUrl: string;
  settings: Settings;
  memory?: DocumentMemory;
  domainMemory?: DomainMemory;
  manualContext: boolean;
  contextSource: 'manual-session' | 'manual-memory' | 'automatic' | 'default';
}

export type RuleSaveResult = { rule: Rule; previousRule: Rule | null };

/** page / popup / options -> background. */
export interface Requests {
  GET_STATE: { input: Record<string, never>; output: PublicState };
  GET_CONTEXT: { input: Record<string, never>; output: PageContext };
  GET_ACTIVE_PAGE: { input: Record<string, never>; output: ActivePage };
  OPEN_OPTIONS: { input: Record<string, never>; output: Record<string, never> };
  SAVE_SETTINGS: { input: { settings: Partial<Settings>; rememberForCollection?: boolean }; output: PublicState };
  SAVE_PROFILE: { input: { profile: ProfileInput; apiKey?: string }; output: PublicState };
  DELETE_PROFILE: { input: { id: string }; output: PublicState };
  TEST_PROFILE: { input: { id: string }; output: { message: string } };
  START: { input: Record<string, never>; output: Record<string, never> };
  STOP: { input: Record<string, never>; output: Record<string, never> };
  SET_MODE: { input: { mode: DisplayMode }; output: Record<string, never> };
  GET_STATUS: { input: Record<string, never>; output: { status: ContentStatus | null } };
  TRANSLATE: { input: { text: string; heading?: string; documentTitle?: string; jobId: string; seenTerms?: string[]; plainText?: string; codeTexts?: string[] }; output: { text: string; cached: boolean } };
  ANALYZE_DOCUMENT: { input: { jobId: string; documentTitle: string; headings: string[]; sample: string }; output: { context: PageContext; reused: boolean; warning?: string } };
  CANCEL: { input: { jobId: string }; output: Record<string, never> };
  SAVE_RULE: { input: { rule: RuleInput }; output: RuleSaveResult & Partial<PublicState> };
  DELETE_RULE: { input: { id: string }; output: Partial<PublicState> };
  SAVE_SKIP: { input: { text: string }; output: { skip: Skip } };
  DELETE_SKIP: { input: { id: string }; output: Partial<PublicState> };
  EXPLAIN: { input: { text: string; context?: string }; output: { text: string } };
  EXPORT_CONFIG: { input: Record<string, never>; output: { config: ExportedConfig } };
  SAVE_MEMORY: { input: { memory: MemoryInput }; output: PublicState };
  DELETE_MEMORY: { input: { id: string }; output: PublicState };
  DELETE_DOMAIN_MEMORY: { input: { id: string }; output: PublicState };
  CLEAR_SESSIONS: { input: Record<string, never>; output: PublicState };
  IMPORT_CONFIG: { input: { config: unknown }; output: PublicState };
  GET_DIAGNOSTICS: { input: Record<string, never>; output: DiagnosticSnapshot };
}

/** background -> page (content script). */
export interface Pushes {
  GET_CONTENT_STATUS: { input: Record<string, never>; output: ContentStatus };
  START_TRANSLATION: { input: { mode?: DisplayMode }; output: Record<string, never> };
  STOP_TRANSLATION: { input: Record<string, never>; output: Record<string, never> };
  SET_DISPLAY_MODE: { input: { mode: DisplayMode }; output: Record<string, never> };
  RULES_CHANGED: { input: Record<string, never>; output: Record<string, never> };
}

export type RequestType = keyof Requests;
export type PushType = keyof Pushes;
export type MessageType = RequestType | PushType;
export type RequestInput<K extends RequestType> = Requests[K]['input'];
export type RequestOutput<K extends RequestType> = Requests[K]['output'];
export type PushInput<K extends PushType> = Pushes[K]['input'];
export type PushOutput<K extends PushType> = Pushes[K]['output'];

/** A request received by the background, derived from `Requests` so every type needs a case. */
export type RequestMessage = { [K in RequestType]: { type: K } & RequestInput<K> }[RequestType];
export type TranslationRequest = Extract<RequestMessage, { type: 'TRANSLATE' }>;
export type AnalysisRequest = Extract<RequestMessage, { type: 'ANALYZE_DOCUMENT' }>;

/** A message received by the content script. */
export type ContentPush = { [K in PushType]: { type: K } & PushInput<K> }[PushType];

/**
 * Single source of truth for every message-type string. The mapped `satisfies`
 * clause fails to compile when a type is added to `Requests`/`Pushes` without a
 * matching entry here, or when a value drifts from its key.
 */
export const MESSAGE_TYPES = {
  GET_STATE: 'GET_STATE',
  GET_CONTEXT: 'GET_CONTEXT',
  GET_ACTIVE_PAGE: 'GET_ACTIVE_PAGE',
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  SAVE_PROFILE: 'SAVE_PROFILE',
  DELETE_PROFILE: 'DELETE_PROFILE',
  TEST_PROFILE: 'TEST_PROFILE',
  START: 'START',
  STOP: 'STOP',
  SET_MODE: 'SET_MODE',
  GET_STATUS: 'GET_STATUS',
  TRANSLATE: 'TRANSLATE',
  ANALYZE_DOCUMENT: 'ANALYZE_DOCUMENT',
  CANCEL: 'CANCEL',
  SAVE_RULE: 'SAVE_RULE',
  DELETE_RULE: 'DELETE_RULE',
  SAVE_SKIP: 'SAVE_SKIP',
  DELETE_SKIP: 'DELETE_SKIP',
  EXPLAIN: 'EXPLAIN',
  EXPORT_CONFIG: 'EXPORT_CONFIG',
  SAVE_MEMORY: 'SAVE_MEMORY',
  DELETE_MEMORY: 'DELETE_MEMORY',
  DELETE_DOMAIN_MEMORY: 'DELETE_DOMAIN_MEMORY',
  CLEAR_SESSIONS: 'CLEAR_SESSIONS',
  IMPORT_CONFIG: 'IMPORT_CONFIG',
  GET_DIAGNOSTICS: 'GET_DIAGNOSTICS',
  GET_CONTENT_STATUS: 'GET_CONTENT_STATUS',
  START_TRANSLATION: 'START_TRANSLATION',
  STOP_TRANSLATION: 'STOP_TRANSLATION',
  SET_DISPLAY_MODE: 'SET_DISPLAY_MODE',
  RULES_CHANGED: 'RULES_CHANGED',
} as const satisfies { readonly [K in MessageType]: K };

/**
 * Sends a request to the background and unwraps the `{ ok, ...data }` envelope.
 * Call sites keep the page/options wording for an unusable response through
 * `fallbackMessage`.
 */
export async function send<K extends RequestType>(type: K, payload: RequestInput<K>, fallbackMessage = '插件连接中断，请刷新页面后重试。'): Promise<RequestOutput<K>> {
  const response: unknown = await chrome.runtime.sendMessage({ type, ...payload });
  const envelope = response as { ok?: boolean; error?: unknown } | null | undefined;
  if (!envelope?.ok) throw new Error(typeof envelope?.error === 'string' ? envelope.error : fallbackMessage);
  return response as RequestOutput<K>;
}

/** Sends a push message to a tab's content script. */
export async function sendToTab<K extends PushType>(tabId: number, type: K, payload: PushInput<K>): Promise<PushOutput<K>> {
  return await chrome.tabs.sendMessage(tabId, { type, ...payload }) as PushOutput<K>;
}

export function requireNonEmptyText(value: unknown, maxLength: number, message: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(message);
  return value;
}

export function requireText(value: unknown, maxLength: number, message: string): string {
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(message);
  return value;
}

export function requireTextList(value: unknown, maxLength: number, maxItems: number, message: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || item.length > maxLength)) throw new Error(message);
  return value as string[];
}

/** Compile-time guarantee that every message type has an implementation. */
export function assertNeverUnhandled(value: never): never {
  void value;
  throw new Error('不支持的操作，请刷新插件后重试。');
}
