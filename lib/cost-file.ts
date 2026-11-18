import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

// Key the lock by the target, not by the spelling of an alias. Follow dangling
// file symlinks too, since a normal write can create their target.
function resolveFileTarget(path: string): string {
  for (let hops = 0; hops <= 40; hops++) {
    try {
      return realpathSync.native(path);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }
    let link: string;
    try {
      link = readlinkSync(path);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'EINVAL')) throw error;
      return join(realpathSync.native(dirname(path)), basename(path));
    }
    path = isAbsolute(link) ? link : `${dirname(path)}${sep}${link}`;
  }
  throw new Error(`Too many symlinks resolving ${path}`);
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));

function withFileLock(path: string, update: () => void): void {
  const lock = `${path}.lock`;
  const deadline = performance.now() + 2000;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw error;
      const remaining = deadline - performance.now();
      // Never reclaim on age alone; a paused writer may still own the lock.
      if (remaining <= 0) throw new Error(`Timed out waiting for file lock ${lock}`);
      Atomics.wait(lockWait, 0, 0, Math.min(20, remaining));
    }
  }
  try {
    update();
  } finally {
    rmdirSync(lock);
  }
}

function replaceFile(path: string, data: string, mode?: number): void {
  const temp = join(dirname(path), `.atomic-${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', mode === undefined ? 0o666 : 0o600);
  let published = false;
  try {
    try {
      writeFileSync(fd, data, 'utf-8');
      if (mode !== undefined) fchmodSync(fd, mode & 0o7777);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    published = true;
  } finally {
    if (!published) unlinkSync(temp);
  }
}

export function loadAccumulatedCost(): number {
  const costFile = process.env.RLM_COST_FILE;
  if (!costFile) {
    return 0;
  }
  try {
    const content = readFileSync(costFile, 'utf-8');
    return parseFloat(content) || 0;
  } catch {
    return 0;
  }
}

export function addAccumulatedCost(cost: number): void {
  const costFile = process.env.RLM_COST_FILE;
  if (!costFile) return;

  const target = resolveFileTarget(costFile);
  withFileLock(target, () => {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`Not a regular cost file: ${target}`);
    let current = 0;
    if (stat) {
      const content = readFileSync(target, 'utf-8').trim();
      current = Number(content);
      if (
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(content) ||
        !Number.isFinite(current)
      ) {
        throw new Error(
          `Malformed cost file ${target}. Repair the total before recording more cost.`
        );
      }
    }
    const total = current + cost;
    if (!Number.isFinite(total)) throw new Error('Accumulated cost must be finite');
    replaceFile(target, total.toFixed(6), stat?.mode);
  });
}
