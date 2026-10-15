import type { Settings } from '../shared/types.ts';
import type { ReadingState, TranslationBlock } from './state.ts';

export interface ToolbarUi {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  toolbar: HTMLElement;
  menu: HTMLElement;
  toast: HTMLElement;
  progress: HTMLElement;
  domain: HTMLElement;
  startButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  updateButton: HTMLButtonElement;
  modeButtons: Map<Settings['mode'], HTMLButtonElement>;
}

/**
 * Shared surface for the content-script modules. Each module owns its own DOM and
 * helpers; anything two modules need to call is declared here so imports stay
 * acyclic and the wiring lives in `index.ts`.
 */
export interface ContentRuntime {
  state: ReadingState;
  ui: ToolbarUi;
  render(): void;
  cleanup(): void;
  showError(error: unknown): void;
  showToast(message: string, undo?: () => void | Promise<void>): void;
  setMode(mode: unknown): void;
  startTranslation(force?: boolean): Promise<void>;
  stopTranslation(): void;
  retryBlock(block: TranslationBlock): Promise<void>;
  markStale(): void;
  saveSkip(block: TranslationBlock): Promise<void>;
  scopeValue(scope: string): string;
}
