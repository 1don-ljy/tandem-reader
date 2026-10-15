import { FORMAT_VERSION } from '../shared/translation-output.ts';

/**
 * Storage surface the migration table may touch. Passing it in keeps the table
 * testable without a live `chrome.storage`.
 */
export interface MigrationContext {
  local: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
  };
  session: {
    get(keys: null): Promise<Record<string, unknown>>;
    remove(keys: string[]): Promise<void>;
  };
  clearSessions(): Promise<void>;
}

export interface Migration {
  /** Schema version this migration produces. Migrations run in ascending order. */
  to: number;
  run(context: MigrationContext): Promise<void>;
}

/**
 * Ordered, idempotent migrations. Append new entries with the next `to` value;
 * never edit or renumber an entry that has shipped.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    to: 1,
    async run({ clearSessions, session }) {
      // Old assistants may contain the echoed request envelope. Keep user-owned
      // rules, domain memories and credentials; discard generated results only.
      await clearSessions();
      const data = await session.get(null);
      await session.remove(Object.keys(data).filter(key => key.startsWith('cache:') || key.startsWith('job:')));
    },
  },
];

export function latestVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((version, migration) => Math.max(version, migration.to), 0);
}

export const SCHEMA_VERSION = latestVersion();

/** Applies every migration newer than `from`, in ascending order, and returns the new version. */
export async function runMigrations(context: MigrationContext, from: number, migrations: readonly Migration[] = MIGRATIONS): Promise<number> {
  let version = from;
  for (const migration of [...migrations].sort((a, b) => a.to - b.to)) {
    if (migration.to <= version) continue;
    await migration.run(context);
    version = migration.to;
  }
  return version;
}

/**
 * The migration that the pre-versioning `translationFormatVersion` flag used to represent.
 * Must stay equal to the first entry of `MIGRATIONS`.
 */
const FORMAT_MIGRATION_VERSION = 1;

/**
 * Applies pending migrations and records `schemaVersion`. Running it again on an
 * up-to-date profile performs no migration work and writes nothing.
 */
export async function migrateStorage(ports: MigrationContext, migrations: readonly Migration[] = MIGRATIONS): Promise<number> {
  const stored = await ports.local.get(['schemaVersion', 'translationFormatVersion']);
  const current = typeof stored.schemaVersion === 'number' ? stored.schemaVersion : 0;
  // Profiles migrated by the pre-versioning code carry FORMAT_VERSION, so everything up to
  // that point is already applied even when schemaVersion is still absent. A mismatched
  // flag means the format migration is still pending, which is how the old code decided;
  // newer migrations are then recomputed from schemaVersion as usual.
  const from = stored.translationFormatVersion === FORMAT_VERSION
    ? Math.max(current, FORMAT_MIGRATION_VERSION)
    : Math.min(current, FORMAT_MIGRATION_VERSION - 1);
  const version = await runMigrations(ports, from, migrations);
  // A pending format flag must be rewritten even when the schema version already matches,
  // so a cleared or tampered flag cannot keep reporting work as outstanding.
  if (version > current || stored.translationFormatVersion !== FORMAT_VERSION) {
    await ports.local.set({ schemaVersion: version, translationFormatVersion: FORMAT_VERSION });
  }
  return version;
}
