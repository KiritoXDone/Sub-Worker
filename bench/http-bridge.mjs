import { metricsContext } from './metrics.mjs';
import { getDynamicFunctionFactory, registerDynamicFunctionFactory } from '../vendor/sub-store/backend/src/utils/dynamic-function-runtime.js';

// Benchmark-only prototype of the missing HTTP bridge. The upstream files remain unchanged.
export function installHttpBridge() {
  const original = getDynamicFunctionFactory();
  registerDynamicFunctionFactory((spec) => {
    const run = original({
    ...spec,
    script: `$substore.http = __benchHttp;\n${spec.script}`,
    bindings: {
      ...spec.bindings,
      __benchHttp: Object.fromEntries(['get', 'post', 'put', 'delete', 'head', 'patch'].map(method => [
        method,
        async options => {
          const metrics = metricsContext.getStore();
          if (metrics && metrics.fetches >= 40) throw new Error('HTTP_BUDGET_EXCEEDED: 40 calls per invocation');
          const response = await fetch(options.url, {
            method: method.toUpperCase(), headers: options.headers,
            body: ['get', 'head'].includes(method) ? undefined : options.body,
            redirect: 'manual', signal: AbortSignal.timeout(8000),
          });
          if (response.status >= 300 && response.status < 400) throw new Error('HTTP_REDIRECT_REQUIRES_BUDGETED_FOLLOW');
          return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
        },
      ])),
    },
    });
    return async (...args) => {
      try { return await run(...args); }
      catch (error) {
        const metrics = metricsContext.getStore();
        if (metrics) metrics.scriptError = String(error.message || error);
        throw error;
      }
    };
  });
}
