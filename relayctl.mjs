#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { disable, enable, locations, readJson, status, watchState } from './lib/relay.mjs';

const script = fileURLToPath(import.meta.url);
const root = path.dirname(script);
const loc = locations();
const registry = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie', 'plugins.json');
const command = process.argv[2] || 'status';

function magpie(args) {
  const result = spawnSync(process.env.MAGPIE_BIN || 'magpie', args, {
    encoding: 'utf8', timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Magpie 指令失敗。');
}

function localRow() {
  return readJson(registry)?.data.plugins?.find((row) => row.spec === root);
}

function install() {
  if (process.versions.bun) throw new Error('請使用 Node.js 執行 node relayctl.mjs install。');
  if (!localRow()) magpie(['plugin', 'add', root]);
  const row = localRow();
  if (!row) throw new Error('找不到剛安裝的插件。請確認 Magpie 使用的是標準 XDG 設定目錄。');
  const oldKey = row.options?.controlKey;
  const controlKey = /^[a-f0-9]{64}$/.test(oldKey ?? '') ? oldKey : randomBytes(32).toString('hex');
  if (controlKey !== oldKey || row.options?.nodePath !== process.execPath) {
    const options = { ...row.options, controlKey, nodePath: process.execPath };
    magpie(['plugin', 'options', root, JSON.stringify(options)]);
  }
  if (row.off === true) magpie(['plugin', 'on', root]);
  console.log('已安裝。開啟 Magpie 側欄的 Remote Relay／模型轉發。');
}

function withLock(operation, args) {
  fs.mkdirSync(loc.stateDir, { mode: 0o700, recursive: true });
  const result = spawnSync('flock', ['-w', '10', '-o', path.join(loc.stateDir, 'control.lock'),
    process.execPath, script, '_locked', operation, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status === 1) throw new Error('另一個切換仍在執行，請稍後再試。');
  process.exitCode = result.status ?? 1;
}

function startWatch(id) {
  const child = spawn('flock', ['-w', '4', '-o', path.join(loc.stateDir, 'watch.lock'),
    process.execPath, script, '_watch', id], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function watch(id) {
  for (;;) {
    try {
      const wanted = watchState(loc, id);
      if (wanted === 'done') return;
      if (wanted === 'disable') {
        spawnSync('flock', ['-w', '2', '-o', path.join(loc.stateDir, 'control.lock'),
          process.execPath, script, '_locked', 'guard', id], { stdio: 'ignore' });
      }
    } catch {
      // Magpie and Claude can replace their config files while the watcher reads them.
    }
    await wait(1200);
  }
}

async function locked(action, args) {
  if (action === 'on') {
    const [registryFile, spec] = args;
    const row = registryFile ? null : localRow();
    const state = await enable(loc, { registry: registryFile || (row && registry), spec: spec || row?.spec });
    if (state.registry) startWatch(state.id);
    console.log(JSON.stringify(await status(loc)));
  } else if (action === 'off' || action === 'guard') {
    const result = await disable(loc, action === 'guard' ? args[0] : undefined);
    if (action === 'off' && !result.done) startWatch(result.guardId);
    console.log(JSON.stringify(result));
  }
}

try {
  if (process.platform !== 'linux') throw new Error('目前支援 Linux。');
  switch (command) {
    case 'install': install(); break;
    case 'status': console.log(JSON.stringify(await status(loc))); break;
    case 'on':
    case 'off': withLock(command, process.argv.slice(3)); break;
    case '_locked': await locked(process.argv[3], process.argv.slice(4)); break;
    case '_watch': await watch(process.argv[3]); break;
    default: throw new Error('用法：node relayctl.mjs install|status|on|off');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
