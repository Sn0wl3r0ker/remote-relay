import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const ownerName = /^(\d+)-[a-f0-9-]{36}$/;
const busyErrors = new Set(['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM', 'EBUSY']);

function ownerGone(name) {
  const match = ownerName.exec(name);
  const pid = Number(match?.[1]);
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function removeOwner(lock, name) {
  try {
    if (name) fs.rmSync(path.join(lock, name), { force: true });
    fs.rmdirSync(lock);
  } catch (error) {
    if (error.code !== 'ENOENT' && !busyErrors.has(error.code)) throw error;
  }
}

function releaseAbandoned(lock) {
  try {
    const names = fs.readdirSync(lock);
    if (names.length === 0 || (names.length === 1 && ownerGone(names[0]))) removeOwner(lock, names[0]);
  } catch (error) {
    if (error.code !== 'ENOENT' && !busyErrors.has(error.code)) throw error;
  }
}

export async function withDirectoryLock(lock, seconds, operation) {
  const owner = `${process.pid}-${randomUUID()}`;
  const pending = fs.mkdtempSync(`${lock}-`);
  let acquired = false;
  try {
    // Acquire by renaming a populated directory, so a reaper can never remove a new owner's empty directory.
    fs.writeFileSync(path.join(pending, owner), '', { flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + seconds * 1000;
    do {
      try {
        fs.renameSync(pending, lock);
        acquired = true;
      } catch (error) {
        if (!busyErrors.has(error.code)) throw error;
        releaseAbandoned(lock);
      }
      if (acquired) return await operation();
      await wait(100);
    } while (Date.now() < deadline);
    throw new Error('另一個切換仍在執行，請稍後再試。');
  } finally {
    if (acquired) removeOwner(lock, owner);
    else fs.rmSync(pending, { recursive: true, force: true });
  }
}
