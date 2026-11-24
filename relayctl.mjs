#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { withDirectoryLock } from './lib/lock.mjs';
import { pluginEntry } from './lib/magpie.mjs';
import { disable, enable, locations, status, watchState } from './lib/relay.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.dirname(script);
const loc = locations();
const configHome = process.env.XDG_CONFIG_HOME || '';
const registry = path.join(path.isAbsolute(configHome) ? configHome : path.join(os.homedir(), '.config'), 'magpie', 'plugins.json');
const command = process.argv[2] || 'status';

function magpie(args) {
  const result = spawnSync(process.env.MAGPIE_BIN || 'magpie', args, {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Magpie 指令失敗。');
}

function install() {
  if (!pluginEntry(registry, root)) magpie(['plugin', 'add', root]);
  const row = pluginEntry(registry, root);
  if (!row) throw new Error('找不到剛安裝的插件。請確認 Magpie 使用的是標準 XDG 設定目錄。');
  const oldKey = row.options?.controlKey;
  const controlKey = /^[a-f0-9]{64}$/.test(oldKey ?? '') ? oldKey : randomBytes(32).toString('hex');
  if (controlKey !== oldKey || row.options?.nodePath !== process.execPath) {
    const options = { ...row.options, controlKey, nodePath: process.execPath };
    magpie(['plugin', 'options', row.spec, JSON.stringify(options)]);
  }
  if (row.off === true) magpie(['plugin', 'on', row.spec]);
  console.log('已安裝。開啟 Magpie 側欄的 Remote Relay／模型轉發。');
}

async function withLock(operation, seconds = 10, name = 'control.lock') {
  fs.mkdirSync(loc.stateDir, { mode: 0o700, recursive: true });
  const lockPath = path.join(loc.stateDir, name);
  if (process.platform !== 'linux' || !fs.existsSync(lockPath)) {
    return withDirectoryLock(`${lockPath}.d`, seconds, operation);
  }
  return withLegacyLock(lockPath, seconds, operation);
}

async function withLegacyLock(lockPath, seconds, operation) {
  // Existing Linux watchers still coordinate through flock on the original lock file.
  // The helper keeps the lock until its stdin closes. Cleanup can run even after Magpie deletes the package.
  const lock = spawn('flock', ['-w', String(seconds), lockPath,
    'sh', '-c', 'printf 1; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
  lock.stdin.on('error', () => {});
  const closed = new Promise((resolve) => lock.once('close', resolve));
  try {
    const acquired = await Promise.race([
      new Promise((resolve, reject) => {
        lock.stdout.once('data', () => resolve(true));
        lock.once('error', reject);
      }),
      closed.then(() => false),
    ]);
    if (!acquired) throw new Error('另一個切換仍在執行，請稍後再試。');
    return await operation();
  } finally {
    lock.stdin.end();
    await closed;
  }
}

async function startWatch(id) {
  const child = spawn(process.execPath, [script, '_watch', id], {
    detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  try {
    // Wait until the watcher has loaded its code, before Magpie can remove the files it came from.
    const [ready] = await Promise.race([
      once(child.stdout, 'data', { signal: AbortSignal.timeout(3000) }),
      once(child, 'close').then(() => []),
    ]);
    if (ready?.toString().trim() !== 'ready') throw new Error('無法啟動背景復原程序。');
  } finally {
    child.stdout.destroy();
    child.unref();
  }
}

async function watch(id) {
  console.log('ready');
  await withLock(async () => {
    for (;;) {
      try {
        const wanted = watchState(loc, id);
        if (wanted === 'done') return;
        if (wanted === 'disable') await withLock(() => disable(loc, id), 2);
      } catch {
        // Magpie and Claude can replace their config files while the watcher reads them.
      }
      await wait(1200);
    }
  }, 6, 'watch.lock');
}

async function turnOn(registryFile, spec) {
  const row = registryFile ? null : pluginEntry(registry, root);
  const state = await enable(loc, { registry: registryFile || (row && registry), spec: spec || row?.spec });
  if (state.registry) {
    try {
      await startWatch(state.id);
    } catch (error) {
      await disable(loc);
      throw error;
    }
  }
  console.log(JSON.stringify(await status(loc)));
}

async function turnOff() {
  const result = await disable(loc);
  if (!result.done) await startWatch(result.guardId);
  console.log(JSON.stringify(result));
}

try {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('目前支援 macOS、Linux 和 Windows。');
  if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('Remote Relay 需要 Node.js 20 以上。');
  }
  switch (command) {
    case 'install': install(); break;
    case 'status': console.log(JSON.stringify(await status(loc))); break;
    case 'on': await withLock(() => turnOn(process.argv[3], process.argv[4])); break;
    case 'off': await withLock(turnOff); break;
    case '_locked':
      // A watcher started by v0.1.0 already holds the lock when it asks for cleanup.
      if (process.argv[3] === 'guard') await disable(loc, process.argv[4]);
      break;
    case '_watch': await watch(process.argv[3]); break;
    default: throw new Error('用法：node relayctl.mjs install|status|on|off');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
