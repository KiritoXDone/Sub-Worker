import { createMetrics, metricsContext, instrumentContext, summarize } from './metrics.mjs';

const BATCH_SIZE = 40;
const CONCURRENCY = 4;
const TTL_MS = 24 * 60 * 60 * 1000;
export class EnrichmentDO {
  constructor(ctx) {
    this.ctx = instrumentContext(ctx);
    this.sql = this.ctx.storage.sql;
    this.queue = Promise.resolve();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL, total INTEGER NOT NULL, automatic INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS geo (id INTEGER PRIMARY KEY, country TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS batch_log (seq INTEGER PRIMARY KEY, start_cursor INTEGER, end_cursor INTEGER, fetches INTEGER, rows_read INTEGER, rows_written INTEGER, elapsed_ms REAL);
    `);
  }
  enqueue(run) {
    const task = this.queue.then(run, run);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
  fetch(request) {
    return this.enqueue(async () => {
      const path = new URL(request.url).pathname;
      if (path === '/start') {
        const { total = 999, automatic = true, clearCache = false } = await request.json();
        if (!Number.isInteger(total) || total < 1 || total > 999) return new Response('Invalid count', { status: 400 });
        await this.ctx.storage.transaction(async txn => {
          this.sql.exec('DELETE FROM batch_log');
          if (clearCache) this.sql.exec('DELETE FROM geo');
          this.sql.exec('INSERT OR REPLACE INTO job VALUES (1, 0, ?, ?)', total, Number(automatic));
          if (automatic) await txn.setAlarm(Date.now() + 20);
          else await txn.deleteAlarm();
        });
      } else if (path === '/step') {
        await this.step();
      } else if (path === '/resume') {
        await this.ctx.storage.transaction(async txn => {
          this.sql.exec('UPDATE job SET automatic = 1 WHERE id = 1');
          await txn.setAlarm(Date.now() + 20);
        });
      }
      const job = this.sql.exec('SELECT * FROM job WHERE id = 1').toArray()[0];
      if (path === '/report') {
        return Response.json({ job, rows: this.sql.exec('SELECT COUNT(*) AS n FROM geo').one().n,
          databaseBytes: this.sql.databaseSize, batches: this.sql.exec('SELECT * FROM batch_log ORDER BY seq').toArray() });
      }
      return Response.json({ job });
    });
  }
  alarm() { return this.enqueue(() => this.step()); }
  async step() {
    const metrics = createMetrics();
    const started = performance.now();
    return metricsContext.run(metrics, async () => {
      const job = this.sql.exec('SELECT * FROM job WHERE id = 1').toArray()[0];
      if (!job || job.cursor >= job.total) return;
      const end = Math.min(job.cursor + BATCH_SIZE, job.total);
      const fetched = [];
      for (let offset = job.cursor; offset < end; offset += CONCURRENCY) {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, end - offset) }, async (_, n) => {
          const id = offset + n;
          const cached = this.sql.exec('SELECT country, expires FROM geo WHERE id = ?', id).toArray()[0];
          if (cached?.expires > Date.now()) return;
          const response = await fetch(`https://fixture.invalid/geo/${id}`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
          if (!response.ok) throw new Error(`Geo request failed: ${response.status}`);
          const data = await response.json();
          fetched.push({ id, country: data.country });
        }));
      }
      await this.ctx.storage.transaction(async txn => {
        for (const item of fetched) {
          this.sql.exec('INSERT INTO geo VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET country=excluded.country, expires=excluded.expires', item.id, item.country, Date.now() + TTL_MS);
        }
        this.sql.exec('UPDATE job SET cursor = ? WHERE id = 1', end);
        if (end < job.total && job.automatic) await txn.setAlarm(Date.now() + 20);
        const summary = summarize(metrics);
        this.sql.exec('INSERT OR REPLACE INTO batch_log VALUES (?, ?, ?, ?, ?, ?, ?)',
          Math.floor(job.cursor / BATCH_SIZE), job.cursor, end, summary.fetches,
          summary.sqlRowsRead, summary.sqlRowsWritten + 1, performance.now() - started);
      });
    });
  }
}
export default { fetch(request, env) { return env.JOBS.getByName('single-user').fetch(request); } };
