import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './relay.mjs';

const packageName = 'magpie-remote-relay';

function sameDirectory(a, b) {
  if (a === b) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function pluginEntry(registry, root) {
  const rows = readJson(registry)?.data.plugins;
  if (!Array.isArray(rows)) return null;
  const local = rows.find((row) => typeof row.spec === 'string' && path.isAbsolute(row.spec) && sameDirectory(row.spec, root));
  if (local) return local;

  // Magpie keeps the Git URL in plugins.json and Bun's package name in plugins/package.json.
  const packages = path.join(path.dirname(registry), 'plugins');
  const installed = path.join(packages, 'node_modules', packageName);
  if (!sameDirectory(installed, root)) return null;
  const spec = readJson(path.join(packages, 'package.json'))?.data.dependencies?.[packageName];
  return typeof spec === 'string' ? rows.find((row) => row.spec === spec) ?? null : null;
}
