export const NODE_COUNT = 999;
const uuid = '11111111-1111-4111-8111-111111111111';
export const lines = Array.from({ length: NODE_COUNT }, (_, i) => {
  const host = `node-${i}.example.invalid`;
  const name = encodeURIComponent(`HK 香港 ${String(i + 1).padStart(4, '0')}`);
  if (i % 3 === 0) return `ss://${Buffer.from('aes-128-gcm:synthetic-password').toString('base64')}@${host}:443#${name}`;
  if (i % 3 === 1) return `trojan://synthetic-password@${host}:443?sni=edge.example.invalid#${name}`;
  return `vless://${uuid}@${host}:443?security=tls&type=ws&host=edge.example.invalid&path=%2Fws&sni=edge.example.invalid#${name}`;
});
export const uri = lines.join('\n');
export const base64 = Buffer.from(uri).toString('base64');
export const builtinOperations = [
  { type: 'Regex Rename Operator', args: [{ expr: '^HK', now: '香港' }] },
  { type: 'Handle Duplicate Operator', args: { action: 'delete', field: ['server', 'port'] } },
  { type: 'Sort Operator', args: 'asc' },
];
export function scriptOperation(script) {
  return { type: 'Script Operator', args: { mode: 'script', content: script } };
}
export const renameScript = `function operator(proxies) {
  return proxies.map((p, i) => ({ ...p, name: 'QJS-' + i + '-' + p.name, udp: true }));
}`;
export const httpScript = `async function operator(proxies) {
  const response = await $substore.http.get({ url: 'https://fixture.invalid/geo/0' });
  const country = JSON.parse(response.body).country;
  return proxies.map(p => ({ ...p, name: country + '-' + p.name }));
}`;
export const excessiveHttpScript = `async function operator(proxies) {
  for (let i = 0; i < proxies.length; i++) {
    const response = await $substore.http.get({ url: 'https://fixture.invalid/geo/' + i });
    proxies[i].name = JSON.parse(response.body).country + '-' + proxies[i].name;
  }
  return proxies;
}`;
export function localSubscription(name, content = uri, operations = []) {
  return { name, source: 'local', content, process: operations, noFlow: true };
}
