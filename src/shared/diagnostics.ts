/** How many recent events the in-memory diagnostic ring buffer keeps. */
export const DIAGNOSTIC_LIMIT = 200;

export type DiagnosticPhase = 'start' | 'done' | 'error';

/**
 * One structured event. Every field is a timestamp, an identifier, a phase or a
 * classification code - never page text, a translation or a credential.
 */
export interface DiagnosticEvent {
  at: number;
  type: string;
  tabId?: number;
  jobId?: string;
  phase: DiagnosticPhase;
  durationMs?: number;
  ok: boolean;
  errorCode?: string;
}

export interface DiagnosticSnapshot {
  version: 1;
  generatedAt: number;
  limit: number;
  events: DiagnosticEvent[];
}

export interface DiagnosticInput {
  at: number;
  type: string;
  phase: DiagnosticPhase;
  ok: boolean;
  tabId?: unknown;
  jobId?: unknown;
  durationMs?: unknown;
  errorCode?: unknown;
}

/**
 * Bounded, in-memory event log for support reports. It lives only in the service
 * worker, is never persisted, and `record` copies a fixed field list so a caller
 * cannot smuggle page text, translations or keys into a report.
 */
export class Diagnostics {
  readonly limit: number;
  private events: DiagnosticEvent[] = [];

  constructor(limit: number = DIAGNOSTIC_LIMIT) {
    this.limit = limit;
  }

  record(input: DiagnosticInput): DiagnosticEvent {
    const event: DiagnosticEvent = { at: input.at, type: input.type, phase: input.phase, ok: input.ok };
    if (typeof input.tabId === 'number') event.tabId = input.tabId;
    if (typeof input.jobId === 'string') event.jobId = input.jobId;
    if (typeof input.durationMs === 'number') event.durationMs = input.durationMs;
    if (typeof input.errorCode === 'string') event.errorCode = input.errorCode;
    this.events.push(event);
    if (this.events.length > this.limit) this.events.splice(0, this.events.length - this.limit);
    return event;
  }

  list(): DiagnosticEvent[] {
    return this.events.map(event => ({ ...event }));
  }

  clear(): void {
    this.events = [];
  }

  snapshot(): DiagnosticSnapshot {
    return { version: 1, generatedAt: Date.now(), limit: this.limit, events: this.list() };
  }
}

const ERROR_CODES = ['timeout', 'aborted', 'offline', 'model-error', 'permission', 'unsupported', 'failed'] as const;

/**
 * Maps a thrown error to one of a fixed set of codes. The message itself is never
 * returned, so model output or page text carried by an error cannot be exported.
 */
export function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('25 秒')) return 'timeout';
  if (message.includes('已停止')) return 'aborted';
  if (message.includes('无法连接')) return 'offline';
  if (message.includes('未完成')) return 'model-error';
  if (message.includes('授权') || message.includes('权限')) return 'permission';
  if (message.includes('不支持')) return 'unsupported';
  return 'failed';
}

export function isDiagnosticErrorCode(value: string): boolean {
  return (ERROR_CODES as readonly string[]).includes(value);
}
