import { DEFAULT_SETTINGS } from '../shared/core.ts';
import { Diagnostics } from '../shared/diagnostics.ts';
import type { AppData, KeyStores, PublicState } from '../shared/types.ts';
import { MemoryRepository } from '../memory/repository.ts';
import { migrateStorage, type MigrationContext } from './migrations.ts';

export type Page = { tabId: number; url: string };
export type CacheEntry = { text: string; seen: string[]; at: number };

/** Shared background state: persisted data plus in-flight request bookkeeping. */
export const memory = new MemoryRepository();
export const controllers = new Map<string, AbortController>();

/** Recent structured events for support reports. In-memory only, never persisted. */
export const diagnostics = new Diagnostics();

const migrationPorts: MigrationContext = {
  local: { get: keys => chrome.storage.local.get(keys), set: values => chrome.storage.local.set(values) },
  session: { get: () => chrome.storage.session.get(null), remove: keys => chrome.storage.session.remove(keys) },
  clearSessions: () => memory.clearSessions(),
};

/** One-time startup work: storage access levels and the schema migrations. */
export const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
]).then(() => migrateStorage(migrationPorts)).then(() => undefined);

let writeQueue: Promise<unknown> = Promise.resolve();

export function serialWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

/** Aborts every in-flight request except the ones owned by `tabId`. */
export function abortOtherJobs(tabId?: number): void {
  for (const [key, controller] of controllers) {
    if (tabId !== undefined && (key.startsWith(`job:${tabId}:`) || key === `explain:${tabId}`)) continue;
    controller.abort();
  }
}

/** Aborts the jobs belonging to one tab. */
export function abortJobsForTab(tabId: number, includeExplain = true): void {
  for (const [key, controller] of controllers) {
    if (key.startsWith(`job:${tabId}:`) || (includeExplain && key === `explain:${tabId}`)) controller.abort();
  }
}

export async function readData(): Promise<AppData> {
  const data = await chrome.storage.local.get(['settings', 'profiles', 'rules', 'skips', 'revision']) as Partial<AppData>;
  return {
    settings: { ...DEFAULT_SETTINGS, ...data.settings }, profiles: data.profiles || [],
    rules: data.rules || [], skips: data.skips || [], revision: data.revision || 0
  };
}

export async function readKeys(): Promise<KeyStores> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get('localKeys'), chrome.storage.session.get('sessionKeys')
  ]);
  return { local: local.localKeys as Record<string, string> || {}, session: session.sessionKeys as Record<string, string> || {} };
}

export async function publicState(): Promise<PublicState> {
  const [data, keys, memories, sessions, domainMemories] = await Promise.all([readData(), readKeys(), memory.listMemories(), memory.listSessions(), memory.listDomainMemories()]);
  return {
    settings: data.settings, rules: data.rules, skips: data.skips, memories, sessions, domainMemories,
    profiles: data.profiles.map(profile => ({
      ...profile, hasKey: Boolean(keys[profile.keyPersistence]?.[profile.id])
    }))
  };
}
