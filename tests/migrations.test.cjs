const { test } = require('node:test');
const assert = require('node:assert/strict');

const modulePromise = import('../src/background/migrations.ts');

function harness(initialLocal = {}, initialSession = {}) {
  const local = structuredClone(initialLocal);
  const session = structuredClone(initialSession);
  const calls = { cleared: 0, removed: [], writes: [] };
  return {
    calls,
    local,
    session,
    ports: {
      local: {
        async get(keys) {
          const result = {};
          for (const key of keys) result[key] = structuredClone(local[key]);
          return result;
        },
        async set(values) {
          calls.writes.push(structuredClone(values));
          Object.assign(local, structuredClone(values));
        },
      },
      session: {
        async get() { return structuredClone(session); },
        async remove(keys) {
          calls.removed.push(...keys);
          for (const key of keys) delete session[key];
        },
      },
      async clearSessions() { calls.cleared += 1; },
    },
  };
}

test('migration table is ordered, unique and defines the schema version', async () => {
  const { MIGRATIONS, SCHEMA_VERSION } = await modulePromise;
  const versions = MIGRATIONS.map((migration) => migration.to);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(SCHEMA_VERSION, versions.at(-1));
  assert.ok(SCHEMA_VERSION >= 1);
});

test('applying migrations records schemaVersion and a repeated run has no side effects', async () => {
  const { migrateStorage, SCHEMA_VERSION } = await modulePromise;
  const state = harness({}, { 'cache:a': { at: 1 }, 'job:b': { at: 1 }, 'allowed:1': 'https://docs.example.com/' });

  assert.equal(await migrateStorage(state.ports), SCHEMA_VERSION);
  assert.equal(state.calls.cleared, 1);
  assert.deepEqual(state.calls.removed.sort(), ['cache:a', 'job:b']);
  assert.equal(state.local.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.local.translationFormatVersion, 'plain-text-v2');
  assert.deepEqual(state.session, { 'allowed:1': 'https://docs.example.com/' });

  assert.equal(await migrateStorage(state.ports), SCHEMA_VERSION);
  assert.equal(state.calls.cleared, 1, 'a second run must not clear sessions again');
  assert.deepEqual(state.calls.removed.sort(), ['cache:a', 'job:b'], 'a second run must not remove more keys');
  assert.equal(state.calls.writes.length, 1, 'a second run must not write storage again');
});

test('profiles that already ran the legacy format migration never repeat it', async () => {
  const { migrateStorage, SCHEMA_VERSION } = await modulePromise;
  const state = harness({ translationFormatVersion: 'plain-text-v2' }, { 'cache:a': { at: 1 }, 'job:b': { at: 1 } });

  assert.equal(await migrateStorage(state.ports), SCHEMA_VERSION);
  assert.equal(state.calls.cleared, 0);
  assert.deepEqual(state.calls.removed, []);
  assert.deepEqual(state.session, { 'cache:a': { at: 1 }, 'job:b': { at: 1 } });
  assert.equal(state.local.schemaVersion, SCHEMA_VERSION);
});

test('the pre-versioning flag maps to the first migration of the table', async () => {
  const { MIGRATIONS } = await modulePromise;
  assert.equal(MIGRATIONS[0].to, 1, 'migrateStorage assumes the legacy format migration is migration 1');
});

test('a mismatched format flag re-applies the pre-versioning migration', async () => {
  const { migrateStorage, SCHEMA_VERSION } = await modulePromise;
  const state = harness(
    { schemaVersion: SCHEMA_VERSION, translationFormatVersion: 'legacy-json-v1' },
    { 'cache:legacy-envelope': { at: 1 }, 'job:legacy-envelope': { at: 1 }, 'allowed:1': 'https://docs.example.com/' }
  );

  assert.equal(await migrateStorage(state.ports), SCHEMA_VERSION);
  assert.equal(state.calls.cleared, 1, 'a pending format migration must run again');
  assert.deepEqual(state.calls.removed.sort(), ['cache:legacy-envelope', 'job:legacy-envelope']);
  assert.deepEqual(state.session, { 'allowed:1': 'https://docs.example.com/' });
  assert.equal(state.local.translationFormatVersion, 'plain-text-v2', 'the flag must be rewritten');
  assert.equal(state.local.schemaVersion, SCHEMA_VERSION);

  const writes = state.calls.writes.length;
  assert.equal(await migrateStorage(state.ports), SCHEMA_VERSION);
  assert.equal(state.calls.cleared, 1);
  assert.equal(state.calls.writes.length, writes, 'the repaired flag must not write again');
});

test('a legacy profile neither repeats the format migration nor skips newer ones', async () => {
  const { migrateStorage } = await modulePromise;
  const applied = [];
  const table = [
    { to: 1, async run() { applied.push(1); } },
    { to: 2, async run() { applied.push(2); } },
  ];
  const state = harness({ translationFormatVersion: 'plain-text-v2' }, {});

  assert.equal(await migrateStorage(state.ports, table), 2);
  assert.deepEqual(applied, [2], 'migration 1 is already applied, migration 2 is still pending');
  assert.equal(state.local.schemaVersion, 2);
});

test('only migrations newer than the stored version run, in ascending order', async () => {
  const { runMigrations } = await modulePromise;
  const applied = [];
  const table = [
    { to: 3, async run() { applied.push(3); } },
    { to: 2, async run() { applied.push(2); } },
  ];

  assert.equal(await runMigrations({}, 0, table), 3);
  assert.deepEqual(applied, [2, 3]);

  applied.length = 0;
  assert.equal(await runMigrations({}, 2, table), 3);
  assert.deepEqual(applied, [3]);

  applied.length = 0;
  assert.equal(await runMigrations({}, 3, table), 3);
  assert.deepEqual(applied, [], 'an up-to-date profile runs nothing');
});
