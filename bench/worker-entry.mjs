import { createMetrics, metricsContext, instrumentContext, summarize } from './metrics.mjs';
import upstream, { SubStoreDO } from '../vendor/sub-store/backend/src/platforms/cloudflare/index.js';
import { installHttpBridge } from './http-bridge.mjs';
import { runWithInitializationStorage } from '../vendor/sub-store/backend/src/platforms/cloudflare/legacy-globals.js';

installHttpBridge();
export class MeasuredSubStoreDO extends SubStoreDO {
  constructor(ctx, env) {
    super(instrumentContext(ctx), env);
    this.benchStorage = ctx.storage;
  }
  async handleRequest(request) {
    const metrics = createMetrics();
    const start = performance.now();
    return metricsContext.run(metrics, async () => {
      const url = new URL(request.url);
      let response;
      if (url.pathname === '/_bench/cache') {
        const sql = this.benchStorage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS bench_output (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
        if (request.method === 'PUT') {
          const cursor = sql.exec('INSERT OR REPLACE INTO bench_output VALUES (?, ?)', 'one', await request.text());
          metrics.cursors.push(cursor);
          response = new Response('stored');
        } else {
          const cursor = sql.exec('SELECT body FROM bench_output WHERE id = ?', 'one');
          const row = cursor.toArray()[0];
          metrics.cursors.push(cursor);
          response = new Response(row?.body ?? '', { status: row ? 200 : 404 });
        }
      } else if (url.pathname === '/_bench/storage') {
        response = Response.json({ databaseBytes: this.benchStorage.sql.databaseSize });
      } else if (url.pathname === '/_bench/normalized') {
        await this.ready;
        const { ProxyUtils } = await import('../vendor/sub-store/backend/src/core/proxy-utils/index.js');
        const sql = this.benchStorage.sql;
        sql.exec('CREATE TABLE IF NOT EXISTS bench_normalized (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
        if (request.method === 'PUT') {
          const body = await request.text();
          metrics.cursors.push(sql.exec('INSERT OR REPLACE INTO bench_normalized VALUES (?, ?)', 'one', body));
          response = new Response('stored');
        } else {
          const cursor = sql.exec('SELECT body FROM bench_normalized WHERE id = ?', 'one');
          const row = cursor.toArray()[0];
          metrics.cursors.push(cursor);
          if (!row) response = new Response('not found', { status: 404 });
          else response = await runWithInitializationStorage(this.storage, () => new Response(ProxyUtils.produce(JSON.parse(row.body), 'ClashMeta')));
        }
      } else {
        if (request.headers.get('x-bench-clear-source-cache') === '1') {
          await this.ready;
          const { default: resourceCache } = await import('../vendor/sub-store/backend/src/utils/resource-cache.js');
          await runWithInitializationStorage(this.storage, () => resourceCache.revokeAll());
        }
        const now = Date.now;
        if (request.headers.get('x-bench-freeze-clock') === '1') Date.now = () => 0;
        try { response = await super.handleRequest(request); }
        finally { Date.now = now; }
        if (metrics.scriptError) response = Response.json({ status: 'failed', error: metrics.scriptError }, { status: 422 });
      }
      const result = new Response(response.body, response);
      result.headers.set('x-bench-metrics', JSON.stringify({ ...summarize(metrics), localDoElapsedMs: performance.now() - start }));
      return result;
    });
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith('/_bench/')) {
      return env.SUB_STORE.getByName('default').fetch(request);
    }
    return upstream.fetch(request, env);
  },
};
