import fs from 'node:fs';
import path from 'node:path';

export function realPath(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  const left = realPath(a);
  const right = realPath(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
