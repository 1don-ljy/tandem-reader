import type { PageContext, Settings, Skip } from '../shared/types.ts';
import type { CodeFragment } from './dom.ts';

export interface TranslationBlock {
  node: HTMLElement;
  source: HTMLElement;
  wrapper: HTMLSpanElement | null;
  output: HTMLDivElement | null;
  originalText: string;
  text: string;
  codes: CodeFragment[];
  heading: string;
  status: 'pending' | 'done' | 'error';
  skip: Skip | null;
}

/**
 * Identity of one translation run. Replaces the old `generation` counter: a run is
 * current only while the very same token is still the state's current run, so
 * stale callbacks are discarded by reference comparison instead of by number.
 */
export interface RunToken {
  id: number;
  jobId: string;
  startedAt: number;
}

/**
 * Run lifecycle. Only `loading`/`analyzing`/`translating` are active; `idle`,
 * `stopped` and `error` are terminal and all render the same way (the message
 * carries the distinction), so illegal combinations such as "busy but idle" or a
 * phase without a run cannot be constructed.
 */
export type RunState =
  | { kind: 'idle' }
  | { kind: 'loading'; run: RunToken }
  | { kind: 'analyzing'; run: RunToken }
  | { kind: 'translating'; run: RunToken }
  | { kind: 'stopped'; run: RunToken }
  | { kind: 'error'; run: RunToken; message: string };

export interface ReadingState {
  run: RunState;
  pageUrl: string;
  mode: Settings['mode'];
  context: PageContext | null;
  blocks: TranslationBlock[];
  selection: { text: string; block: TranslationBlock } | null;
  stale: boolean;
  message: string;
  analysisNote: string;
  undo: (() => void | Promise<void>) | null;
}

let nextRunId = 0;

export function newRunToken(jobId: string): RunToken {
  return { id: ++nextRunId, jobId, startedAt: Date.now() };
}

/** The token of the current run, or `null` when the state is idle. */
export function currentRun(run: RunState): RunToken | null {
  return run.kind === 'idle' ? null : run.run;
}

/** True while a request is in flight (loading, analyzing or translating). */
export function isActive(run: RunState): boolean {
  return run.kind === 'loading' || run.kind === 'analyzing' || run.kind === 'translating';
}

/** Reference comparison against the state's current run. */
export function isSameRun(state: ReadingState, run: RunToken | null): boolean {
  return currentRun(state.run) === run;
}

export function createState(): ReadingState {
  return {
    run: { kind: 'idle' },
    pageUrl: location.href.replace(/#.*$/, ''),
    mode: 'dual',
    context: null,
    blocks: [],
    selection: null,
    stale: false,
    message: '准备好后，开始阅读这篇文档。',
    analysisNote: '',
    undo: null,
  };
}
