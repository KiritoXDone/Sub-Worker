import { AsyncLocalStorage } from 'node:async_hooks';

export const metricsContext = new AsyncLocalStorage();
export function createMetrics() {
  return { cursors: [], fetches: 0, quickjs: [], logs: 0, errors: [] };
}
export function instrumentStorage(storage) {
  const sql = new Proxy(storage.sql, {
    get(target, key) {
      if (key === 'exec') return (...args) => {
        const cursor = target.exec(...args);
        metricsContext.getStore()?.cursors.push(cursor);
        return cursor;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return new Proxy(storage, {
    get(target, key) {
      if (key === 'sql') return sql;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
export function instrumentContext(ctx) {
  const storage = instrumentStorage(ctx.storage);
  return new Proxy(ctx, {
    get(target, key) {
      if (key === 'storage') return storage;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (...args) => {
  const metrics = metricsContext.getStore();
  if (metrics) metrics.fetches++;
  return nativeFetch(...args);
};
globalThis.__benchQuickJSMemory = (value) => metricsContext.getStore()?.quickjs.push(value);

// Do not benchmark console capture/IPC. Error bodies and returned results are checked by the host.
for (const level of ['log', 'info', 'warn', 'debug', 'error']) {
  console[level] = (...args) => {
    const m = metricsContext.getStore();
    if (m) {
      m.logs++;
      const message = args.map(String).join(' ');
      if ((level === 'error' || /Error|FAILED|错误/.test(message)) && m.errors.length < 4) m.errors.push(message.slice(0, 500));
    }
  };
}
export function summarize(metrics) {
  return {
    sqlRowsRead: metrics.cursors.reduce((sum, c) => sum + c.rowsRead, 0),
    sqlRowsWritten: metrics.cursors.reduce((sum, c) => sum + c.rowsWritten, 0),
    fetches: metrics.fetches,
    quickjs: metrics.quickjs,
    logCallsSuppressed: metrics.logs,
    errors: metrics.errors,
  };
}
