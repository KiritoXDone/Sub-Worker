import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRuntime, call, connectInspector, workerdSnapshot, here } from './local-runtime.mjs';
import { uri, localSubscription, builtinOperations } from './fixtures.mjs';

const requireBackend = createRequire(resolve(here, '../vendor/sub-store/backend/package.json'));
const YAML = requireBackend('yaml');
const { mf, mockCalls } = createRuntime();
let inspector;
const result = { nodes: 999, repeats: 12, cases: [] };
async function measure(name, request, expectedFetches, expectedOutput) {
  const startCalls = mockCalls.length;
  const before = workerdSnapshot();
  const samples = [];
  for (let i = 0; i < result.repeats; i++) {
    const { text, ...sample } = await request();
    assert.equal(sample.status, 200, text.slice(0, 400));
    const nodes = YAML.parse(text).proxies;
    assert.equal(nodes.length, 999);
    assert.equal(new Set(nodes.map(n => n.server)).size, 999);
    if (expectedOutput !== undefined) assert.equal(text, expectedOutput);
    assert.equal(sample.metrics.fetches, expectedFetches);
    samples.push(sample);
  }
  const after = workerdSnapshot();
  assert.equal(mockCalls.length - startCalls, result.repeats * expectedFetches);
  const heapAfter = await inspector.request('Runtime.getHeapUsage');
  const gc = inspector.request('HeapProfiler.collectGarbage');
  await call(mf, '/_bench/storage'); await gc;
  const heapAfterGc = await inspector.request('Runtime.getHeapUsage');
  const sorted = samples.map(s => s.wallMs).sort((a, b) => a - b);
  const item = { name, cpuMsPerRequest: (after.cpuMs - before.cpuMs) / samples.length,
    wallMedianMs: sorted[Math.ceil(sorted.length / 2) - 1], wallP95Ms: sorted.at(-1),
    mockHttpCalls: mockCalls.length - startCalls, heapAfter, heapAfterGc, samples };
  result.cases.push(item);
  console.log(JSON.stringify({ ...item, samples: undefined }));
}
try {
  await mf.ready; inspector = await connectInspector(mf);
  await call(mf, '/bench-admin/api/subs', [localSubscription('normalized', uri)], 'PUT');
  const parsed = await call(mf, '/download/normalized?target=JSON&noFlow=1');
  const reference = await call(mf, '/download/normalized?target=ClashMeta&noFlow=1');
  assert.equal(JSON.parse(parsed.text).length, 999);
  await call(mf, '/_bench/normalized', parsed.text, 'PUT');
  await measure('sqlite-normalized-cache-to-mihomo', () => call(mf, '/_bench/normalized'), 0, reference.text);

  const sources = Array.from({ length: 3 }, (_, i) => ({ name: `cold-${i}`, source: 'remote', url: `https://fixture.invalid/source/${i}`, noFlow: true, noCache: true }));
  await call(mf, '/bench-admin/api/subs', sources, 'PUT');
  await call(mf, '/bench-admin/api/collections', [{ name: 'cold', subscriptions: sources.map(s => s.name), process: builtinOperations }], 'PUT');
  await measure('three-remote-sources-forced-network', () => call(mf, '/download/collection/cold?target=ClashMeta&noFlow=1', undefined, 'GET', { 'x-bench-clear-source-cache': '1' }), 3);
} catch (error) {
  result.error = String(error.stack || error);
  throw error;
} finally {
  await writeFile(resolve(here, 'cache-results.json'), JSON.stringify(result, null, 2));
  inspector?.close(); await mf.dispose();
}
