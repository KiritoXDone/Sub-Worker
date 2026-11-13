import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntime, call, connectInspector, workerdSnapshot, here } from './local-runtime.mjs';
import { NODE_COUNT, uri, base64, localSubscription, builtinOperations, scriptOperation, renameScript, httpScript, excessiveHttpScript } from './fixtures.mjs';

const requireBackend = createRequire(resolve(here, '../vendor/sub-store/backend/package.json'));
const YAML = requireBackend('yaml');
const repeats = 12;
let { mf, mockCalls } = createRuntime();
let inspector;
const results = {
  date: new Date().toISOString(), nodes: NODE_COUNT, repeats,
  source: { repo: 'kasumikira/sub-worker', sha: '413d06ff23d7f61201c509fc01fdda2a6c0aed1e', version: '2.44.2', miniflare: '4.20260730.0', workerd: '1.20260730.1', quickjs: '0.32.0', compatibilityDate: '2026-07-30' },
  environment: { node: process.version, cpu: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(), platform: process.platform, arch: process.arch },
  method: {
    cpu: 'Delta of macOS ps cumulative CPU for descendant workerd process, divided by batch request count; ps resolution 10ms. Includes local runtime/storage overhead, excludes Node harness. NOT Cloudflare billed CPU.',
    elapsed: 'End-to-end local wall time; DO elapsed includes waiting. These are NOT CPU timings.',
    memory: 'CDP heap snapshots plus QuickJS live guest allocation and WASM linear-memory snapshots. NOT production isolate peak. RSS is whole workerd process.',
    network: 'All external HTTP handled by local fixtures; no real provider traffic. Geo fixture adds a synthetic 5ms wait.',
    modifications: ['benchmark wrapper and SQL counters', 'console output suppressed', 'HTTP bridge with 40-call budget', 'QuickJS interrupt callback budget of 2000 across async segments', 'QuickJS memory observation before disposal', 'explicit script failure propagated as HTTP 422', 'request-scoped download memo', 'forced GC outside timed batches to distinguish retained memory'],
    input: '999 unique synthetic SS/Trojan/VLESS endpoints; 333 each. Passwords and addresses are fake.',
  }, cases: [], checks: [],
};
const save = () => writeFile(resolve(here, 'results.json'), JSON.stringify(results, null, 2));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
function validate(result, format = 'yaml', namePrefix) {
  assert.equal(result.status, 200, result.text.slice(0, 400));
  const value = format === 'json' ? JSON.parse(result.text) : YAML.parse(result.text);
  const nodes = Array.isArray(value) ? value : value.proxies;
  assert.equal(nodes?.length, NODE_COUNT, result.text.slice(0, 400));
  assert.equal(new Set(nodes.map(node => node.server)).size, NODE_COUNT);
  if (namePrefix) assert.ok(nodes.every(node => node.name.startsWith(namePrefix)));
}
async function seed(content, operations = []) {
  const result = await call(mf, '/bench-admin/api/subs', [localSubscription('bench', content, operations)], 'PUT');
  assert.equal(result.status, 200, result.text);
}
async function measure(name, run, { format = 'yaml', prefix, expectedFetches = 0 } = {}) {
  for (let i = 0; i < 2; i++) validate(await run(), format, prefix);
  const before = workerdSnapshot();
  assert.equal(before.pids.length, 1, 'Expected one dedicated workerd process');
  const callsBefore = mockCalls.length;
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const response = await run();
    validate(response, format, prefix);
    assert.equal(response.metrics.fetches, expectedFetches);
    const { text, ...sample } = response;
    samples.push(sample);
  }
  const after = workerdSnapshot();
  assert.deepEqual(after.pids, before.pids);
  const cpuMsPerRequest = (after.cpuMs - before.cpuMs) / repeats;
  const heap = await inspector.request('Runtime.getHeapUsage');
  const gc = inspector.request('HeapProfiler.collectGarbage');
  // workerd executes this inspector operation when an I/O turn acquires the isolate.
  await call(mf, '/_bench/storage');
  await gc;
  const heapAfterGc = await inspector.request('Runtime.getHeapUsage');
  const item = {
    name, cpuMsPerRequest, wallMedianMs: percentile(samples.map(s => s.wallMs), 0.5),
    wallP95Ms: percentile(samples.map(s => s.wallMs), 0.95), outputBytes: samples[0].bytes,
    mockHttpCalls: mockCalls.length - callsBefore, heapAfter: heap, heapAfterGc,
    processRssAfterBytes: after.processRssBytes, samples,
  };
  results.cases.push(item);
  await save();
  console.log(JSON.stringify({ name, cpuMsPerRequest, wallMedianMs: item.wallMedianMs, wallP95Ms: item.wallP95Ms, outputBytes: item.outputBytes, metrics: samples.at(-1).metrics, heap, heapAfterGc }));
}
try {
  const started = performance.now();
  await mf.ready;
  results.runtimeReadyMs = performance.now() - started;
  inspector = await connectInspector(mf);
  await seed(uri);
  const download = (target = 'ClashMeta') => call(mf, `/download/bench?target=${target}&noFlow=1`);
  const initial = await download();
  validate(initial);
  results.firstDownload = { ...initial, text: undefined };
  const yamlInput = initial.text;
  results.inputBytes = { uri: Buffer.byteLength(uri), base64: Buffer.byteLength(base64), yaml: Buffer.byteLength(yamlInput) };

  await measure('uri-to-json', () => download('JSON'), { format: 'json' });
  await measure('uri-to-mihomo', () => download());
  await seed(base64);
  await measure('base64-to-mihomo', () => download());
  await seed(yamlInput);
  await measure('yaml-to-mihomo', () => download());
  await seed(uri, builtinOperations);
  await measure('three-built-in-operations', () => download());
  await seed(uri, [scriptOperation(renameScript)]);
  await measure('one-quickjs-script', () => download(), { prefix: 'QJS-' });
  await seed(uri, Array.from({ length: 3 }, () => scriptOperation(renameScript)));
  await measure('three-quickjs-scripts', () => download(), { prefix: 'QJS-' });
  await seed(uri, [scriptOperation(httpScript)]);
  await measure('quickjs-one-http-call', () => download(), { prefix: 'HK-', expectedFetches: 1 });

  const remoteSubs = Array.from({ length: 3 }, (_, i) => ({ name: `source-${i}`, source: 'remote', url: `https://fixture.invalid/source/${i}`, noFlow: true }));
  assert.equal((await call(mf, '/bench-admin/api/subs', remoteSubs, 'PUT')).status, 200);
  assert.equal((await call(mf, '/bench-admin/api/collections', [{ name: 'remote', subscriptions: remoteSubs.map(s => s.name), process: builtinOperations }], 'PUT')).status, 200);
  await measure('three-remote-sources-cache-hit', () => call(mf, '/download/collection/remote?target=ClashMeta&noFlow=1'));

  assert.equal((await call(mf, '/_bench/cache', yamlInput, 'PUT')).status, 200);
  await measure('sqlite-output-cache-hit', () => call(mf, '/_bench/cache'));
  results.database = JSON.parse((await call(mf, '/_bench/storage')).text);
  results.bundleBytes = (await stat(resolve(here, 'dist/worker.mjs'))).size;

  await seed(uri, [scriptOperation(excessiveHttpScript)]);
  const limited = await download();
  const budgetFailed = limited.status >= 400 && limited.text.includes('HTTP_BUDGET_EXCEEDED');
  results.checks.push({ name: '999-http-script-budget', passed: budgetFailed, status: limited.status, fetches: limited.metrics.fetches, excerpt: limited.text.slice(0, 700) });
  assert.ok(budgetFailed, `Budget error was not surfaced: ${limited.text.slice(0, 500)}`);
  assert.equal(limited.metrics.fetches, 40);

  // Freeze both the host and guest Date.now; the callback-count guard must still interrupt.
  await seed(uri, [scriptOperation('function operator(proxies) { Date.now = () => 0; while (true) {} }')]);
  const interrupted = await call(mf, '/download/bench?target=ClashMeta&noFlow=1', undefined, 'GET', { 'x-bench-freeze-clock': '1' });
  const loopFailed = interrupted.status >= 400 && /interrupted/.test(interrupted.text);
  results.checks.push({ name: 'quickjs-infinite-loop-with-frozen-host-and-guest-clocks', passed: loopFailed, status: interrupted.status, wallMs: interrupted.wallMs, metrics: interrupted.metrics, excerpt: interrupted.text.slice(0, 700) });
  assert.ok(loopFailed, 'Infinite loop did not fail explicitly');

  await seed(uri, [scriptOperation(renameScript)]);
  const patches = await Promise.all([
    call(mf, '/bench-admin/api/sub/bench', { benchA: 1 }, 'PATCH'),
    call(mf, '/bench-admin/api/sub/bench', { benchB: 2 }, 'PATCH'),
  ]);
  patches.forEach(response => assert.equal(response.status, 200));
  const config = JSON.parse((await call(mf, '/bench-admin/api/sub/bench')).text);
  assert.equal(config.data.benchA, 1);
  assert.equal(config.data.benchB, 2);
  results.checks.push({ name: 'concurrent-patches-preserve-both-fields', passed: true });
  inspector.close(); inspector = undefined;
  await mf.dispose();
  ({ mf, mockCalls } = createRuntime());
  const restored = await call(mf, '/download/bench?target=JSON&noFlow=1');
  validate(restored, 'json', 'QJS-');
  results.checks.push({ name: 'sqlite-survives-workerd-restart', passed: true, nodes: NODE_COUNT, wallMs: restored.wallMs });
  await save();
  console.log(JSON.stringify({ checks: results.checks, database: results.database, bundleBytes: results.bundleBytes }));
} catch (error) {
  results.error = String(error.stack || error);
  await save();
  throw error;
} finally {
  inspector?.close();
  await mf.dispose();
}
