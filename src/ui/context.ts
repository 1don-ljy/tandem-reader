import type { PublicState } from '../shared/types.ts';

/** Read access to the page state plus the shared reload routine owned by `options.ts`. */
export interface OptionsRuntime {
  readonly state: PublicState;
  reloadState(): Promise<void>;
}
