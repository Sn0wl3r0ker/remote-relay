import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual as equal } from 'node:util';
import { realPath, samePath } from './paths.mjs';
import { routerIdentity } from './process.mjs';

const require = createRequire(import.meta.url);
const pluginId = 'model-relay@model-relay';
const aliasNames = ['haiku', 'sonnet', 'opus'];
const aliasKey = (name) => `ANTHROPIC_DEFAULT_${name.toUpperCase()}_MODEL`;
const aliasKeys = aliasNames.map(aliasKey);
const envKeys = ['ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY', ...aliasKeys];
const groupKeys = { env: envKeys, enabledPlugins: [pluginId] };
const loopback = ['127.0.0.1', 'localhost', '::1'];
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p >= 1025 && p <= 65535;
const withLocal = (value = '') => [...new Set([...value.split(',').map((s) => s.trim()).filter(Boolean), ...loopback])].join(',');

export function locations() {
  const dir = realPath(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const stateDir = path.join(dir, '.magpie-remote-relay');
  return {
    dir, stateDir,
    settings: path.join(dir, 'settings.json'),
    live: path.join(dir, 'model-relay.json'),
    parked: path.join(stateDir, 'model-relay.json'),
    state: path.join(stateDir, 'state.json'),
    ca: path.join(dir, 'model-relay-pki', 'ca.pem'),
  };
}

function readFile(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`${path.basename(file)} 必須是一般檔案。`);
    return { text: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseJson(file, input) {
  let data;
  try { data = JSON.parse(input.text); } catch { throw new Error(`${path.basename(file)} 的 JSON 格式有誤。`); }
  if (!record(data)) throw new Error(`${path.basename(file)} 必須包含一個 JSON 物件。`);
  return { ...input, data };
}

export function readJson(file) {
  const input = readFile(file);
  return input && parseJson(file, input);
}

function replaceFile(from, to, previous) {
  for (let attempt = 0; ; attempt++) {
    if (previous !== undefined && readFile(to)?.text !== previous?.text) {
      throw new Error(`${path.basename(to)} 剛被其他程式更新，請重試。`);
    }
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      // A Windows reader can briefly hold the destination open during an atomic replacement.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function writeJson(file, data, previous) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, {
      flag: 'wx', mode: previous?.mode ?? 0o600, flush: true,
    });
    if (previous) fs.chmodSync(temp, previous.mode);
    replaceFile(temp, file, previous);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function configuration(loc, tolerateInvalid = false) {
  const live = readFile(loc.live);
  const parked = readFile(loc.parked);
  if (live && parked) throw new Error('找到兩份 model-relay.json。請先確認要使用哪一份。');
  const file = live || parked;
  if (!file) return null;
  let raw;
  try {
    raw = parseJson(parked ? loc.parked : loc.live, file).data;
    if (raw.format !== 2 || (raw.port !== undefined && !validPort(raw.port))) {
      throw new Error('需要 Model Relay 格式 2 的設定檔，以及有效的轉發連接埠。');
    }
  } catch (error) {
    if (!tolerateInvalid) throw error;
    return { invalid: true, parked: Boolean(parked) };
  }
  const port = raw.port ?? 8950;
  return { raw, port, url: `http://127.0.0.1:${port}`, parked: Boolean(parked), proxy: raw.proxy?.enabled === true };
}

function installedRouters(loc) {
  const index = readJson(path.join(loc.dir, 'plugins', 'installed_plugins.json'));
  const entries = index?.data.plugins?.[pluginId] ?? [];
  return entries.filter((row) => row.scope === 'user' && typeof row.installPath === 'string')
    .map((row) => path.resolve(row.installPath, 'router', 'router.js'));
}

function relayState(loc) {
  const state = readJson(loc.state)?.data;
  if (!state) return null;
  if (!validPort(state.port) || typeof state.id !== 'string' ||
      !['starting', 'on', 'restoring'].includes(state.phase) || !Array.isArray(state.patch) ||
      !state.patch.every((e) => Object.hasOwn(groupKeys, e.group) && groupKeys[e.group].includes(e.key))) {
    throw new Error('Remote Relay 的復原紀錄格式有誤。');
  }
  return state;
}

function relayAddress(value, cfg) {
  return [cfg.url, `http://localhost:${cfg.port}`].some((url) => value === url || value === `${url}/`);
}

function ownCA(value, loc) {
  return samePath(value, loc.ca);
}

function aliases(file, cfg) {
  if (!file) return {};
  const logic = require(path.join(path.dirname(file), 'logic.js'));
  const shape = logic.parseShape(cfg.raw);
  return Object.fromEntries(Object.entries(logic.detectAliases(shape))
    .map(([slot, provider]) => [aliasKey(slot), shape.providers[provider].model]));
}

function relayWiring(settings, loc, cfg, aliasValues) {
  const env = settings.env ?? {};
  const proxy = relayAddress(env.HTTPS_PROXY, cfg);
  const direct = relayAddress(env.ANTHROPIC_BASE_URL, cfg);
  const wiring = {};
  if (direct) wiring.ANTHROPIC_BASE_URL = undefined;
  if (proxy) wiring.HTTPS_PROXY = undefined;
  if (ownCA(env.NODE_EXTRA_CA_CERTS, loc)) wiring.NODE_EXTRA_CA_CERTS = undefined;
  if (proxy && env.NO_PROXY === loopback.join(',')) wiring.NO_PROXY = undefined;
  if (direct || proxy) {
    for (const [key, model] of Object.entries(aliasValues)) {
      if (env[key] === model) wiring[key] = undefined;
    }
  }
  return wiring;
}

function beforeEnable(settings, loc, cfg, aliasValues) {
  const env = settings.env ?? {};
  if (env.ANTHROPIC_BASE_URL && !relayAddress(env.ANTHROPIC_BASE_URL, cfg)) {
    throw new Error('Claude 目前有另一個 ANTHROPIC_BASE_URL。請先在該工具中中斷 Claude 的連線。');
  }
  if (['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].some((key) => env[key] === 'magpie')) {
    throw new Error('Claude 目前使用 Magpie 的連線金鑰。請先在 Magpie 的 Agents 頁面中斷 Claude 的連線。');
  }
  const targets = { ...Object.fromEntries(envKeys.map((key) => [key, env[key]])), ...aliasValues };
  if (cfg.proxy) {
    if (env.HTTPS_PROXY && !relayAddress(env.HTTPS_PROXY, cfg)) {
      throw new Error('Claude 目前使用另一個 HTTPS_PROXY。');
    }
    if (env.NODE_EXTRA_CA_CERTS && !ownCA(env.NODE_EXTRA_CA_CERTS, loc)) {
      throw new Error('Claude 目前使用另一份 NODE_EXTRA_CA_CERTS。');
    }
    Object.assign(targets, {
      ANTHROPIC_BASE_URL: undefined, HTTPS_PROXY: cfg.url, NODE_EXTRA_CA_CERTS: loc.ca,
      NO_PROXY: withLocal(env.NO_PROXY ?? ''),
    });
  } else {
    Object.assign(targets, relayWiring(settings, loc, cfg, {}), { ANTHROPIC_BASE_URL: cfg.url });
  }
  return targets;
}

function plan(settings, targets, baseline) {
  return Object.entries(targets).flatMap(([group, values]) => Object.entries(values).map(([key, after]) => {
    const original = settings[group]?.[key];
    const before = Object.hasOwn(baseline[group] ?? {}, key) ? baseline[group][key] : original;
    return { group, key, original, before, after, hadGroup: Object.hasOwn(settings, group) };
  }));
}

function patchSettings(loc, patch, action) {
  const file = readJson(loc.settings);
  const settings = file?.data ?? {};
  for (const group of Object.keys(groupKeys)) {
    if (Object.hasOwn(settings, group) && !record(settings[group])) {
      throw new Error(`Claude settings.json 的 ${group} 必須是物件。`);
    }
  }
  const next = structuredClone(settings);
  const skipped = [];
  for (const entry of patch) {
    const { group, key, original, before, after, hadGroup } = entry;
    const current = next[group]?.[key];
    const expected = action === 'enable' ? original : after;
    const target = action === 'enable' ? after : action === 'rollback' ? original : before;
    if (equal(current, target)) continue;
    if (!equal(current, expected)) {
      skipped.push(`${group}.${key}`);
      continue;
    }
    if (target === undefined) {
      if (next[group]) delete next[group][key];
      if (!hadGroup && Object.keys(next[group] ?? {}).length === 0) delete next[group];
    } else {
      (next[group] ??= {})[key] = target;
    }
  }
  if (action === 'enable' && skipped.length) throw new Error('啟用期間 Claude 的轉發設定有變更，請重試。');
  if (!equal(settings, next)) writeJson(loc.settings, next, file);
  return skipped;
}

function health(port) {
  return new Promise((resolve) => {
    const unavailable = { router: 'unverified' };
    const request = http.get({ host: '127.0.0.1', port, path: '/__health' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) request.destroy();
      });
      response.on('end', () => {
        try { resolve({ router: 'unverified', info: JSON.parse(body) }); } catch { resolve(unavailable); }
      });
      response.on('error', () => resolve(unavailable));
    });
    request.on('error', (error) => resolve(error.code === 'ECONNREFUSED' ? { router: 'stopped' } : unavailable));
    setTimeout(() => { request.destroy(); resolve(unavailable); }, 1000).unref();
  });
}

async function probe(loc, port, files) {
  const result = await health(port);
  const identity = await routerIdentity(result.info, loc.dir, files);
  return identity ? { ...result, router: 'ready', identity } : result;
}

function ensureProxyCertificate(loc, file) {
  const pki = require(path.join(path.dirname(file), 'pki.js'));
  pki.ensure(loc.dir, { hosts: ['api.anthropic.com'] });
}

async function verifyProxy(loc, port) {
  const host = 'api.anthropic.com';
  const ca = fs.readFileSync(loc.ca);
  const ok = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443` });
    let socket;
    const timeout = setTimeout(() => finish(false), 3000);
    function finish(success) {
      clearTimeout(timeout);
      socket?.destroy();
      req.destroy();
      resolve(success);
    }
    req.once('connect', (res, connection, head) => {
      socket = connection;
      if (res.statusCode !== 200) return finish(false);
      if (head.length) connection.unshift(head);
      socket = tls.connect({ socket: connection, servername: host, ca }, () => finish(true));
      socket.once('error', () => finish(false));
    });
    req.once('error', () => finish(false));
    req.end();
  });
  if (!ok) throw new Error('Model Relay 的 HTTPS 代理本機 TLS 驗證失敗。');
}

function routerFiles(loc, state) {
  return [...new Set([...installedRouters(loc), state?.routerFile].filter(Boolean).flatMap((file) => [file, realPath(file)]))];
}

function usableRouter(file) {
  return fs.existsSync(file) && fs.existsSync(path.join(path.dirname(file), 'logic.js'));
}

function affectedPorts(cfg, state) {
  return [...new Set([cfg?.port, state?.port].filter(validPort))];
}

async function startRouter(loc, cfg, file, files) {
  let result = await probe(loc, cfg.port, files);
  if (result.router === 'unverified') throw new Error(`連接埠 ${cfg.port} 已有其他服務。`);
  if (result.router === 'stopped') {
    const runtime = process.env.MAGPIE_REMOTE_RELAY_NODE || cfg.raw.nodePath ||
      (process.versions.bun ? 'node' : process.execPath);
    const child = spawn(runtime, [file, loc.dir], { detached: true, stdio: 'ignore', windowsHide: true });
    let failed = false;
    child.on('error', () => { failed = true; });
    child.on('exit', () => { failed = true; });
    child.unref();
    for (let attempt = 0; attempt < 40 && !failed; attempt++) {
      await wait(100);
      result = await probe(loc, cfg.port, files);
      if (result.router === 'ready') break;
    }
    if (result.router !== 'ready' && child.exitCode === null && child.pid) child.kill('SIGTERM');
  }
  if (result.router !== 'ready') throw new Error('Model Relay 轉發站啟動失敗，請檢查 model-relay.log。');
  if (cfg.proxy && !(result.info.proxy?.enabled && result.info.proxy?.certificate)) {
    throw new Error('Model Relay 的 HTTPS 代理或憑證尚未就緒。');
  }
  if (cfg.proxy) await verifyProxy(loc, cfg.port);
  return result;
}

async function stopRouter(loc, port, files) {
  let result = await probe(loc, port, files);
  if (result.router !== 'ready' || result.info.inflight > 0) return result.router;
  const current = await routerIdentity(result.info, loc.dir, files);
  if (equal(current, result.identity)) {
    try { process.kill(current.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    await wait(100);
    result = await probe(loc, port, files);
    if (result.router !== 'ready') break;
  }
  return result.router;
}

export function registryEnabled(registry, spec) {
  if (!registry) return true;
  const data = readJson(registry)?.data;
  if (!data || !Array.isArray(data.plugins)) return false;
  return data.plugins.some((row) => row.spec === spec && row.off !== true);
}

export async function status(loc) {
  const cfg = configuration(loc, true);
  const state = relayState(loc);
  const files = routerFiles(loc, state);
  const settings = readJson(loc.settings)?.data ?? {};
  const port = cfg?.port ?? state?.port;
  const probes = await Promise.all(affectedPorts(cfg, state).map((p) => probe(loc, p, files)));
  const result = probes.find((p) => p.router === 'ready') ?? probes[0] ?? { router: 'stopped' };
  const related = cfg?.port && Object.keys(relayWiring(settings, loc, cfg, {})).length > 0;
  const enabled = settings.enabledPlugins?.[pluginId] === true;
  const wired = cfg?.port && relayAddress(settings.env?.[cfg.proxy ? 'HTTPS_PROXY' : 'ANTHROPIC_BASE_URL'], cfg);
  let phase = 'off';
  if (state?.phase === 'restoring') phase = 'restoring';
  else if (state) phase = state.phase === 'on' && wired && enabled && result.router === 'ready' ? 'on' : 'repair';
  else if (related || enabled || result.router === 'ready') phase = 'unmanaged';
  return {
    phase, router: result.router, port, mode: cfg?.port ? (cfg.proxy ? 'proxy' : 'base-url') : null,
    configured: Boolean(cfg?.port), invalidConfig: cfg?.invalid === true, installed: files.some(usableRouter),
    activeRequests: result.router === 'ready' ? result.info.inflight : 0,
  };
}

export async function enable(loc, options) {
  const state = relayState(loc);
  if (state?.phase === 'restoring') throw new Error('轉發站仍在停用中。');
  if (options.registry && !registryEnabled(options.registry, options.spec)) throw new Error('Magpie 已停用 Remote Relay 插件。');
  const cfg = configuration(loc);
  if (!cfg) throw new Error('找不到 model-relay.json，請先設定 Model Relay。');
  const files = routerFiles(loc, state);
  const file = files.find(usableRouter);
  if (!file) throw new Error('請先以 user 範圍安裝 Claude Code 的 model-relay@model-relay。');
  const previous = await probe(loc, cfg.port, files);
  if (previous.router === 'unverified') throw new Error(`連接埠 ${cfg.port} 已有其他服務。`);
  if (state) {
    if (state.port !== cfg.port || state.proxy !== cfg.proxy) throw new Error('轉發模式或連接埠已變更，請先停用再啟用。');
    if (state.phase === 'starting') await completeEnable(loc, cfg, state, file, files);
    else {
      await startRouter(loc, cfg, file, files);
      patchSettings(loc, state.patch.filter((e) => !aliasKeys.includes(e.key)), 'enable');
    }
    return relayState(loc);
  }
  const settings = readJson(loc.settings)?.data ?? {};
  const aliasValues = aliases(file, cfg);
  const targets = beforeEnable(settings, loc, cfg, aliasValues);
  const baseline = relayWiring(settings, loc, cfg, aliasValues);
  const plugin = settings.enabledPlugins?.[pluginId];
  const next = {
    id: randomUUID(), phase: 'starting', port: cfg.port, proxy: cfg.proxy, routerFile: file,
    patch: plan(settings, { env: targets, enabledPlugins: { [pluginId]: true } }, {
      env: baseline, enabledPlugins: { [pluginId]: plugin === true ? false : plugin },
    }),
    wasParked: cfg.parked, wasRunning: previous.router === 'ready',
    registry: options.registry, spec: options.spec,
  };
  writeJson(loc.state, next);
  await completeEnable(loc, cfg, next, file, files);
  return next;
}

async function completeEnable(loc, cfg, state, file, files) {
  try {
    if (cfg.parked) replaceFile(loc.parked, loc.live, null);
    if (cfg.proxy) ensureProxyCertificate(loc, file);
    await startRouter(loc, cfg, file, files);
    patchSettings(loc, state.patch, 'enable');
    state.phase = 'on';
    writeJson(loc.state, state);
  } catch (error) {
    patchSettings(loc, state.patch, 'rollback');
    if (state.wasParked && fs.existsSync(loc.live)) replaceFile(loc.live, loc.parked, null);
    const remaining = state.wasRunning ? 'ready' : await stopRouter(loc, state.port, files);
    if (state.wasRunning || remaining !== 'ready') fs.rmSync(loc.state, { force: true });
    throw error;
  }
}

export async function disable(loc, guardId) {
  let state = relayState(loc);
  if (guardId && state?.id !== guardId) return { ...(await status(loc)), done: true };
  const cfg = configuration(loc, Boolean(state));
  const files = routerFiles(loc, state);
  if (!state && cfg && !cfg.parked) {
    const settings = readJson(loc.settings)?.data ?? {};
    const baseline = relayWiring(settings, loc, cfg, aliases(files.find(usableRouter), cfg));
    const plugin = settings.enabledPlugins?.[pluginId];
    state = {
      id: randomUUID(), phase: 'restoring', port: cfg.port,
      patch: plan(settings, { env: Object.fromEntries(Object.keys(baseline).map((k) => [k, settings.env[k]])),
        enabledPlugins: { [pluginId]: plugin } }, { env: baseline, enabledPlugins: { [pluginId]: plugin === true ? false : plugin } }),
    };
  }
  if (!state) return { ...(await status(loc)), done: true };
  if (guardId && state.phase === 'on' && registryEnabled(state.registry, state.spec)) return { done: false };
  // /provider can change the running relay's alias, mode or port. Those fields still belong to this relay.
  if (state.phase === 'on' && cfg?.raw && !cfg.parked) {
    const settings = readJson(loc.settings)?.data ?? {};
    const env = settings.env ?? {};
    const owned = relayWiring(settings, loc, cfg, aliases(files.find(usableRouter), cfg));
    for (const entry of state.patch) {
      if (entry.group !== 'env') continue;
      if (Object.hasOwn(owned, entry.key) || (entry.key === 'NO_PROXY' &&
          Object.hasOwn(owned, 'HTTPS_PROXY') && env.NO_PROXY === withLocal(entry.before ?? ''))) {
        entry.after = env[entry.key];
      }
    }
  }
  state.phase = 'restoring';
  writeJson(loc.state, state);
  const skipped = patchSettings(loc, state.patch, 'disable');
  if (cfg && !cfg.parked) replaceFile(loc.live, loc.parked, null);
  const results = await Promise.all(affectedPorts(cfg, state).map((port) => stopRouter(loc, port, files)));
  const done = !results.includes('ready');
  if (done) fs.rmSync(loc.state, { force: true });
  return { ...(await status(loc)), skipped, done, guardId: state.id };
}

export function watchState(loc, id) {
  const state = relayState(loc);
  if (state?.id !== id) return 'done';
  return state.phase === 'restoring' || !registryEnabled(state.registry, state.spec) ? 'disable' : 'wait';
}
