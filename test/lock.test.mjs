import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { withDirectoryLock } from '../lib/lock.mjs';

test('a second process can use an abandoned lock after its holder exits', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-relay-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, 'control.lock.d');
  const moduleUrl = new URL('../lib/lock.mjs', import.meta.url).href;
  const code = `
    import { withDirectoryLock } from ${JSON.stringify(moduleUrl)};
    await withDirectoryLock(process.argv[1], 1, () => {
      console.log('ready');
      return new Promise(() => setInterval(() => {}, 1000));
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code, lock], {
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
  });
  const [message] = await Promise.race([once(child.stdout, 'data'), closed.then(() => [])]);
  assert.equal(message?.toString().trim(), 'ready');
  await assert.rejects(withDirectoryLock(lock, 0.2, () => assert.fail('lock is still held')), /切換仍在執行/);
  child.kill();
  await closed;
  assert.equal(await withDirectoryLock(lock, 2, () => 'recovered'), 'recovered');
});
