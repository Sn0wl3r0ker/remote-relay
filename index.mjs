import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { readJson } from './lib/relay.mjs';

const run = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const header = 'x-remote-relay-key';
const actions = new Map([['/api/status', 'status'], ['/api/on', 'on'], ['/api/off', 'off']]);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function hasKey(value, key) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) &&
    typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(key));
}

function reply(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function start(input, options) {
  const port = Number(options?.port ?? 3495);
  if (!Number.isInteger(port) || port < 1025 || port > 65535) throw new Error('Remote Relay 的控制連接埠無效。');
  const registry = path.join(input.directory, 'plugins.json');
  const authority = `127.0.0.1:${port}`;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== 'null' && req.headers.origin !== `http://${authority}`)) {
      return reply(res, 403, { error: '拒絕此來源。' });
    }
    const route = req.url?.split('?')[0];
    const asset = assets.get(route);
    if (asset && req.method === 'GET') {
      const [file, mime] = asset;
      const content = fs.readFileSync(path.join(root, 'ui', file));
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' http://${authority}; style-src 'self' http://${authority}; connect-src 'self' http://${authority}; base-uri 'none'; form-action 'none'`);
      res.writeHead(200, { 'Content-Type': mime });
      return res.end(content);
    }
    const action = actions.get(route);
    if (!action) return reply(res, 404, { error: '找不到此功能。' });
    if (req.headers.origin === 'null') {
      res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      res.setHeader('Access-Control-Allow-Headers', header);
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== (action === 'status' ? 'GET' : 'POST')) return reply(res, 405, { error: '不支援此方法。' });
    void (async () => {
      try {
        const row = readJson(registry)?.data.plugins?.find((p) => p.spec === root && p.off !== true);
        if (!hasKey(req.headers[header], row?.options?.controlKey)) return reply(res, 403, { error: '請從 Magpie 的 Remote Relay 頁面開啟。' });
        const node = row.options.nodePath;
        if (typeof node !== 'string' || !path.isAbsolute(node) || !fs.existsSync(node)) {
          return reply(res, 409, { error: '找不到安裝時使用的 Node.js。請重新執行 node relayctl.mjs install。' });
        }
        const args = action === 'on' ? [registry, row.spec] : [];
        const result = await run(node, [path.join(root, 'relayctl.mjs'), action, ...args], { timeout: 25000 });
        reply(res, 200, JSON.parse(result.stdout));
      } catch (error) {
        reply(res, 409, { error: error.stderr?.trim() || '切換失敗，請用 relayctl.mjs status 檢查。' });
      }
    })();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {};
}

export default { id: 'magpie-remote-relay', server: start };
