import { createRequire, builtinModules } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const backend = resolve(here, '../vendor/sub-store/backend');
const requireBackend = createRequire(resolve(backend, 'package.json'));
const { build } = requireBackend('esbuild');
const staticPeggy = requireBackend('./cloudflare-peggy-plugin.js');
const builtinNames = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const builtinPlugin = { name: 'node-builtins', setup(build) {
  build.onResolve({ filter: /.*/ }, args => {
    if (args.path !== 'buffer' && builtinNames.has(args.path.replace(/^node:/, ''))) {
      return { path: args.path.startsWith('node:') ? args.path : `node:${args.path}`, external: true };
    }
  });
} };

const measurementPlugin = {
  name: 'quickjs-memory-observation',
  setup(build) {
    build.onLoad({ filter: /src\/utils\/download\.js$/ }, async args => {
      const code = await readFile(args.path, 'utf8');
      const marker = 'const tasks = new Map();';
      if (!code.includes(marker)) throw new Error('Upstream download memo marker changed');
      return { loader: 'js', resolveDir: dirname(args.path), contents:
        `import { requestDownloadTasks } from ${JSON.stringify(resolve(here, 'request-state.mjs'))};\n` + code.replace(marker, `const tasks = {
          has: key => requestDownloadTasks().has(key),
          get: key => requestDownloadTasks().get(key),
          set: (key, value) => requestDownloadTasks().set(key, value),
        };`) };
    });
    build.onLoad({ filter: /platforms\/cloudflare\/quickjs-runtime\.js$/ }, async args => {
      let code = await readFile(args.path, 'utf8');
      const deadline = `    vm.runtime.setInterruptHandler(\n        shouldInterruptAfterDeadline(Date.now() + EXECUTION_LIMIT_MS),\n    );`;
      if (!code.includes(deadline)) throw new Error('Upstream execution budget marker changed');
      code = `import { installExecutionBudget, readExecutionBudget } from ${JSON.stringify(resolve(here, 'execution-budget.mjs'))};\n` + code.replace(deadline, '    installExecutionBudget(vm.runtime);');
      const marker = '        vm.dispose();\n        runtime.dispose();';
      if (!code.includes(marker)) throw new Error('Upstream instrumentation marker changed');
      return { loader: 'js', resolveDir: dirname(args.path), contents: code.replace(marker, `
        try {
          const handle = runtime.computeMemoryUsage();
          const guest = vm.dump(handle);
          handle.dispose();
          const module = await getQuickJSModule();
          globalThis.__benchQuickJSMemory?.({ guest, wasmLinearBytes: module.getWasmMemory().buffer.byteLength, budget: readExecutionBudget(runtime) });
        } finally {
          vm.dispose();
          runtime.dispose();
        }`) };
    });
  },
};
await build({
  absWorkingDir: backend,
  entryPoints: [resolve(here, 'worker-entry.mjs')],
  bundle: true, minify: true, sourcemap: true, platform: 'browser', format: 'esm',
  outfile: resolve(here, 'dist/worker.mjs'),
  inject: [requireBackend.resolve('core-js/actual/object/has-own'), resolve(backend, 'src/platforms/cloudflare/legacy-globals.js')],
  loader: { '.wasm': 'copy' }, external: ['node:*'],
  plugins: [measurementPlugin, staticPeggy, builtinPlugin],
  define: { 'globalThis.__SUB_STORE_RUNTIME__': JSON.stringify('cloudflare-worker') },
  logOverride: { 'direct-eval': 'silent' },
});
console.log('Built local benchmark wrapper without modifying upstream source.');
