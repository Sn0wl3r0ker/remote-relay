import path from 'node:path';
import { samePath } from './paths.mjs';
import { readJson } from './relay.mjs';

const packageName = 'magpie-remote-relay';

export function pluginEntry(registry, root) {
  const rows = readJson(registry)?.data.plugins;
  if (!Array.isArray(rows)) return null;
  const local = rows.find((row) => samePath(row.spec, root));
  if (local) return local;

  // Magpie keeps the Git URL in plugins.json and Bun's package name in plugins/package.json.
  const packages = path.join(path.dirname(registry), 'plugins');
  const installed = path.join(packages, 'node_modules', packageName);
  if (!samePath(installed, root)) return null;
  const spec = readJson(path.join(packages, 'package.json'))?.data.dependencies?.[packageName];
  return typeof spec === 'string' ? rows.find((row) => row.spec === spec) ?? null : null;
}
