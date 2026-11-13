import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { here, call, workerdSnapshot } from './local-runtime.mjs';

const requireBackend = createRequire(resolve(here, '../vendor/sub-store/backend/package.json'));
await requireBackend('esbuild').build({ entryPoints: [resolve(here, 'enrichment-worker.mjs')], bundle: true,
  format: 'esm', platform: 'browser', external: ['node:*'], outfile: resolve(here, 'dist/enrichment.mjs') });
let networkCalls = 0;
let maxInflight = 0;
let inflight = 0;
let statusRequests = 0;
function startRuntime() {
  return new Miniflare({ name: 'enrichment-bench', modules: true, scriptPath: resolve(here, 'dist/enrichment.mjs'),
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], cf: false,
    log: new Log(LogLevel.ERROR), durableObjects: { JOBS: { className: 'EnrichmentDO', useSQLite: true } },
    durableObjectsPersist: resolve(here, 'job-state'),
    outboundService: async request => {
      assert.equal(new URL(request.url).hostname, 'fixture.invalid');
      networkCalls++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return Response.json({ country: 'HK' }); }
      finally { inflight--; }
    },
  });
}
async function untilComplete(mf) {
  for (let n = 0; n < 300; n++) {
    const response = await call(mf, '/status'); statusRequests++;
    assert.equal(response.status, 200, response.text);
    const { job } = JSON.parse(response.text);
    if (job?.cursor === job?.total) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Alarm job did not complete within 30 seconds');
}
let mf = startRuntime();
const result = { nodeCount: 999, batchSize: 40, concurrency: 4, syntheticNetworkDelayMs: 5, checks: [] };
try {
  await mf.ready;
  await call(mf, '/start', { total: 999, automatic: false, clearCache: true });
  await call(mf, '/step');
  await call(mf, '/step');
  const beforeRestart = JSON.parse((await call(mf, '/status')).text);
  assert.equal(beforeRestart.job.cursor, 80);
  await mf.dispose();
  mf = startRuntime();
  await mf.ready;
  const restored = JSON.parse((await call(mf, '/status')).text);
  assert.equal(restored.job.cursor, 80);
  result.checks.push({ name: 'job-checkpoint-survives-restart', passed: true, cursor: 80 });
  const before = workerdSnapshot();
  const started = performance.now();
  await call(mf, '/resume', {});
  await untilComplete(mf);
  const after = workerdSnapshot();
  result.cold = { report: JSON.parse((await call(mf, '/report')).text), totalHttpCalls: networkCalls,
    remaining919WallMs: performance.now() - started, remaining919ProcessCpuMs: after.cpuMs - before.cpuMs };
  assert.equal(result.cold.report.rows, 999);
  assert.equal(networkCalls, 999);
  assert.equal(result.cold.report.batches.length, 25);
  assert.ok(result.cold.report.batches.every(batch => batch.fetches <= 40));
  const callsBefore = networkCalls;
  const warmStarted = performance.now();
  const warmCpu = workerdSnapshot();
  await call(mf, '/start', { total: 999, automatic: true });
  await untilComplete(mf);
  result.warm = { report: JSON.parse((await call(mf, '/report')).text),
    httpCalls: networkCalls - callsBefore, wallMs: performance.now() - warmStarted,
    processCpuMs: workerdSnapshot().cpuMs - warmCpu.cpuMs };
  assert.equal(result.warm.httpCalls, 0);
  assert.equal(result.warm.report.rows, 999);
  result.maxInflightHttp = maxInflight;
  result.statusPollRequests = statusRequests;
  assert.ok(maxInflight <= 4);
  result.checks.push({ name: '999-requests-fit-25-batches', passed: true }, { name: 'warm-geo-cache-needs-no-http', passed: true });
  console.log(JSON.stringify(result));
} catch (error) {
  result.error = String(error.stack || error);
  throw error;
} finally {
  await writeFile(resolve(here, 'job-results.json'), JSON.stringify(result, null, 2));
  await mf.dispose();
}
