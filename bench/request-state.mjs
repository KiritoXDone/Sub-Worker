import { metricsContext } from './metrics.mjs';

// The upstream non-Node download memo assumes one app lifecycle per request.
// A Durable Object outlives a request, so this memo must not be module-global.
export function requestDownloadTasks() {
  const context = metricsContext.getStore();
  if (!context) throw new Error('Download memo accessed outside request context');
  context.downloadTasks ??= new Map();
  return context.downloadTasks;
}
