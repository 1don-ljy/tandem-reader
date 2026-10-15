import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withExtension } from './harness.cjs';
import memoryScenarios from './memory-scenarios.cjs';
import providers from './providers.cjs';
import uiScenarios from './ui-scenarios.cjs';

/**
 * Entry point for `npm run test:browser`.
 *
 * The scenarios are grouped by concern but each one records the position it held in the
 * original smoke test, so sorting by `order` reproduces that single sequential session.
 * Every scenario runs as its own `test()`, which turns a failure into a named case
 * instead of one opaque `main()`. Requires a Playwright install via PLAYWRIGHT_MODULE.
 */
const scenarios = [...providers, ...memoryScenarios, ...uiScenarios].sort((a, b) => a.order - b.order);

await withExtension(async session => {
  for (const scenario of scenarios) {
    await test(scenario.name, () => scenario.run(session));
  }
  await test('no unexpected external requests or page errors', () => {
    assert.deepEqual(session.issues, []);
  });
  console.log(`PASS ${session.record.requests.length} local mock requests and ${session.record.presetRequests.length} intercepted official requests; screenshots saved in tests/artifacts`);
  console.log('LIMIT: real browser permission prompts and real model translation quality were not tested.');
});
