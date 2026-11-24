import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pluginEntry } from '../lib/magpie.mjs';

test('a GitHub package uses the options Magpie saved for its exact install source', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-relay-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const registry = path.join(directory, 'plugins.json');
  const packages = path.join(directory, 'plugins');
  const installed = path.join(packages, 'node_modules');
  const source = path.join(directory, 'git-package');
  const localSource = path.join(directory, 'local-package');
  await mkdir(installed, { recursive: true });
  await mkdir(source);
  await mkdir(localSource);
  await symlink(source, path.join(installed, 'magpie-remote-relay'), process.platform === 'win32' ? 'junction' : 'dir');

  const git = { spec: 'github:example-owner/remote-relay', options: { port: 4321 } };
  const local = { spec: localSource, options: { port: 9876 } };
  const unrelated = { spec: 'github:other-owner/remote-relay', options: { port: 9875 } };
  const write = (file, data) => writeFile(file, JSON.stringify(data));
  await write(registry, { plugins: [unrelated, local, git] });
  await write(path.join(packages, 'package.json'), { dependencies: { 'magpie-remote-relay': git.spec } });

  assert.deepEqual(pluginEntry(registry, source), git);
  assert.deepEqual(pluginEntry(registry, localSource), local);
  assert.equal(pluginEntry(registry, directory), null);

  await write(registry, { plugins: [unrelated, local] });
  assert.equal(pluginEntry(registry, source), null);
});
