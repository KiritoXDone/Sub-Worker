import { Miniflare, Log, LogLevel } from 'miniflare';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { lines } from './fixtures.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export function createRuntime() {
  const mockCalls = [];
  const mf = new Miniflare({
    name: 'substore-bench', modules: true, scriptPath: resolve(here, 'dist/worker.mjs'),
    compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'], fallthrough: true }],
    durableObjects: { SUB_STORE: { className: 'MeasuredSubStoreDO', useSQLite: true } },
    durableObjectsPersist: resolve(here, 'state'),
    bindings: { SUB_STORE_FRONTEND_BACKEND_PATH: '/bench-admin' },
    inspectorPort: 0, cf: false, log: new Log(LogLevel.ERROR),
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname !== 'fixture.invalid') throw new Error(`Unexpected external request: ${url.origin}`);
      mockCalls.push({ path: url.pathname, at: performance.now() });
      if (url.pathname.startsWith('/source/')) {
        const index = Number(url.pathname.split('/').at(-1));
        return new Response(lines.slice(index * 333, (index + 1) * 333).join('\n'));
      }
      if (url.pathname.startsWith('/geo/')) {
        await new Promise(resolve => setTimeout(resolve, 5));
        return Response.json({ country: 'HK', asn: 64512, id: Number(url.pathname.split('/').at(-1)) });
      }
      return new Response('fixture not found', { status: 404 });
    },
  });
  return { mf, mockCalls };
}
export async function call(mf, path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) {
  const started = performance.now();
  const response = await mf.dispatchFetch(`http://local.test${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status, text, bytes: Buffer.byteLength(text),
    wallMs: performance.now() - started,
    metrics: JSON.parse(response.headers.get('x-bench-metrics') || '{}'),
  };
}
export function workerdSnapshot() {
  const rows = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,time=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    return match && { pid: +match[1], parent: +match[2], time: match[3], rssBytes: +match[4] * 1024, command: match[5] };
  }).filter(Boolean);
  const descendants = new Set([process.pid]);
  for (let i = 0; i < 5; i++) for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid);
  const runtimes = rows.filter(row => descendants.has(row.pid) && /workerd(?:$|\s)/.test(row.command));
  function cpuMs(time) {
    const parts = time.split(':').map(Number);
    return parts.reduce((sum, part) => sum * 60 + part, 0) * 1000;
  }
  return { pids: runtimes.map(row => row.pid), cpuMs: runtimes.reduce((sum, row) => sum + cpuMs(row.time), 0), processRssBytes: runtimes.reduce((sum, row) => sum + row.rssBytes, 0) };
}
export async function connectInspector(mf) {
  const url = await mf.getInspectorURL();
  const listingUrl = new URL('/json/list', url);
  listingUrl.protocol = 'http:';
  const list = await (await fetch(listingUrl)).json();
  const target = list.find(item => item.title?.includes('substore-bench')) || list[0];
  if (!target) throw new Error('No inspector target');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const handler = pending.get(message.id);
    if (handler) { pending.delete(message.id); clearTimeout(handler.timeout); message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result); }
  });
  return {
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`Inspector timeout: ${method}`)); }, 5000);
        pending.set(requestId, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    },
    close() { socket.close(); },
  };
}
