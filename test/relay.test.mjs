import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const cli = path.join(root, 'relayctl.mjs');
const relayId = 'model-relay@model-relay';
const fixtureRouter = `const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'model-relay.json'), 'utf8'));
const server = http.createServer((req, res) => {
  if (req.url === '/__health') res.end(JSON.stringify({
    ok: true, pid: process.pid, configDir: dir, inflight: Number(fs.existsSync(path.join(dir, 'busy'))),
    proxy: { enabled: Boolean(cfg.proxy?.enabled), certificate: true }
  }));
  else res.end('mock upstream');
});
if (cfg.proxy?.enabled) {
  const pki = path.join(dir, 'model-relay-pki');
  const secure = https.createServer({
    key: fs.readFileSync(path.join(pki, 'leaf.key')), cert: fs.readFileSync(path.join(pki, 'ca.pem')),
  });
  server.on('connect', (_req, socket, head) => {
    socket.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (cfg.proxy.testFailure) return socket.end();
    if (head.length) socket.unshift(head);
    secure.emit('connection', socket);
  });
}
server.listen(cfg.port, '127.0.0.1');
`;

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function fixture(t, config = {}) {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  const home = await mkdtemp(path.join(os.tmpdir(), 'remote-relay-test-'));
  const dir = path.join(home, '.claude');
  const plugin = path.join(dir, 'plugins', 'fixture');
  const registry = path.join(home, '.config', 'magpie', 'plugins.json');
  await mkdir(path.join(plugin, 'router'), { recursive: true });
  await mkdir(path.dirname(registry), { recursive: true });
  const write = (file, data) => writeFile(file, JSON.stringify(data));
  await write(path.join(dir, 'plugins', 'installed_plugins.json'), { plugins: { [relayId]: [{ scope: 'user', installPath: plugin }] } });
  await writeFile(path.join(plugin, 'router', 'router.js'), fixtureRouter);
  await writeFile(path.join(plugin, 'router', 'logic.js'), 'exports.parseShape = c => c; exports.detectAliases = c => c.aliases || {};');
  await writeFile(path.join(plugin, 'router', 'pki.js'), 'exports.ensure = () => {};');
  if (config.proxy?.enabled) {
    const pki = path.join(dir, 'model-relay-pki');
    await mkdir(pki);
    await exec('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-days', '1', '-subj', '/CN=api.anthropic.com', '-addext', 'subjectAltName=DNS:api.anthropic.com',
      '-keyout', path.join(pki, 'leaf.key'), '-out', path.join(pki, 'ca.pem')]);
  }
  const relay = path.join(dir, 'model-relay.json');
  const settings = path.join(dir, 'settings.json');
  const initial = { model: 'opus', env: { OTHER: 'keep' }, enabledPlugins: { another: true } };
  await write(relay, { format: 2, port, providers: {}, ...config });
  await write(settings, initial);
  const setPlugin = (off) => write(registry, { plugins: [{ spec: root, off }] });
  await setPlugin(false);
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: dir, XDG_CONFIG_HOME: path.dirname(path.dirname(registry)) };
  async function ctl(...args) {
    const result = await exec(process.execPath, [cli, ...args], { env, timeout: 15000 });
    return JSON.parse(result.stdout);
  }
  t.after(async () => {
    await rm(path.join(dir, 'busy'), { force: true });
    await ctl('off').catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  return { ctl, write, dir, port, relay, settings, initial, setPlugin, parked: path.join(dir, '.magpie-remote-relay', 'model-relay.json') };
}

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('on → off → on keeps the provider file and unrelated Claude settings', async (t) => {
  const f = await fixture(t, { aliases: { haiku: 'local' }, providers: { local: { model: 'local-1' } } });
  const providerConfig = await readFile(f.relay);
  assert.equal((await f.ctl('on')).phase, 'on');
  assert.equal((await f.ctl('on')).phase, 'on');
  const active = await json(f.settings);
  assert.equal(active.env.ANTHROPIC_BASE_URL, `http://127.0.0.1:${f.port}`);
  assert.equal(active.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'local-1');
  assert.equal(active.enabledPlugins[relayId], true);
  active.env.OTHER = 'changed during relay';
  active.permissions = { defaultMode: 'default' };
  await f.write(f.settings, active);
  const off = await f.ctl('off');
  assert.equal(off.phase, 'off');
  assert.equal(off.router, 'stopped');
  assert.deepEqual(await json(f.settings), {
    ...f.initial, env: { OTHER: 'changed during relay' }, permissions: active.permissions,
  });
  assert.deepEqual(await readFile(f.parked), providerConfig);
  await assert.rejects(readFile(f.relay), { code: 'ENOENT' });
  assert.equal((await f.ctl('on')).phase, 'on');
  assert.deepEqual(await readFile(f.relay), providerConfig);
});

test('pauses existing HTTPS proxy wiring even while the Claude plugin is disabled', async (t) => {
  const f = await fixture(t, { proxy: { enabled: true } });
  const settings = { ...f.initial, enabledPlugins: { [relayId]: false }, env: {
    HTTPS_PROXY: `http://127.0.0.1:${f.port}`,
    NODE_EXTRA_CA_CERTS: path.join(f.dir, 'model-relay-pki', 'ca.pem'),
    NO_PROXY: '127.0.0.1,localhost,::1',
    PRIVATE_KEY: 'stand-in',
  } };
  await f.write(f.settings, settings);
  assert.equal((await f.ctl('status')).phase, 'unmanaged');
  assert.equal((await f.ctl('off')).phase, 'off');
  assert.deepEqual((await json(f.settings)).env, { PRIVATE_KEY: 'stand-in' });
  assert.equal((await f.ctl('on')).mode, 'proxy');
  assert.deepEqual((await json(f.settings)).env, settings.env);
  assert.equal((await f.ctl('off')).phase, 'off');
});

test('disabling the Magpie plugin restores settings after an active request drains', async (t) => {
  const f = await fixture(t);
  await f.ctl('on');
  await writeFile(path.join(f.dir, 'busy'), '1');
  await f.setPlugin(true);
  await until(async () => (await f.ctl('status')).phase === 'restoring');
  assert.deepEqual(await json(f.settings), f.initial);
  await assert.rejects(readFile(f.relay), { code: 'ENOENT' });
  assert.equal((await f.ctl('status')).router, 'ready');
  await rm(path.join(f.dir, 'busy'));
  await until(async () => (await f.ctl('status')).phase === 'off');
  assert.equal((await f.ctl('status')).router, 'stopped');
});

test('a failed proxy check rolls back Claude settings and its new process', async (t) => {
  const f = await fixture(t, { proxy: { enabled: true, testFailure: true } });
  await assert.rejects(f.ctl('on'), /本機 TLS 驗證失敗/);
  assert.deepEqual(await json(f.settings), f.initial);
  assert.equal((await f.ctl('status')).router, 'stopped');
  assert.equal((await json(f.relay)).format, 2);
});

test('switching off preserves a routing field changed by another tool', async (t) => {
  const f = await fixture(t);
  await f.ctl('on');
  const current = await json(f.settings);
  current.env.ANTHROPIC_BASE_URL = 'https://another.example';
  await f.write(f.settings, current);
  const result = await f.ctl('off');
  assert.deepEqual(result.skipped, ['env.ANTHROPIC_BASE_URL']);
  assert.equal((await json(f.settings)).env.ANTHROPIC_BASE_URL, 'https://another.example');
  assert.equal(result.router, 'stopped');
});

test('switching off removes relay wiring added by an upstream mode change', async (t) => {
  const f = await fixture(t, { proxy: { enabled: true } });
  await f.ctl('on');
  const current = await json(f.settings);
  const cfg = await json(f.relay);
  cfg.proxy.enabled = false;
  await f.write(f.relay, cfg);
  delete current.env.HTTPS_PROXY;
  delete current.env.NODE_EXTRA_CA_CERTS;
  delete current.env.NO_PROXY;
  current.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${f.port}`;
  await f.write(f.settings, current);
  assert.equal((await f.ctl('off')).phase, 'off');
  assert.deepEqual(await json(f.settings), f.initial);
});

test('a broken provider file can still be parked and Claude settings restored', async (t) => {
  const f = await fixture(t);
  await f.ctl('on');
  await writeFile(f.relay, '{incomplete');
  const result = await f.ctl('off');
  assert.equal(result.phase, 'off');
  assert.equal(result.invalidConfig, true);
  assert.deepEqual(await json(f.settings), f.initial);
  assert.equal(await readFile(f.parked, 'utf8'), '{incomplete');
});

test('a different process on the relay port is left alone', async (t) => {
  const f = await fixture(t);
  const foreign = http.createServer((_, res) => res.end(JSON.stringify({ ok: true, pid: process.pid, configDir: f.dir })));
  await new Promise((resolve, reject) => {
    foreign.once('error', reject);
    foreign.listen(f.port, '127.0.0.1', resolve);
  });
  t.after(() => foreign.close());
  await assert.rejects(f.ctl('on'), /已有其他服務/);
  assert.deepEqual(await json(f.settings), f.initial);
  const result = await f.ctl('off');
  assert.equal(result.router, 'unverified');
  assert.equal(foreign.listening, true);
});

async function until(condition) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await condition()) return;
    await wait(150);
  }
  assert.fail('timed out waiting for the relay state');
}
