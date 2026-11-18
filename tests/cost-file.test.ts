import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addAccumulatedCost, loadAccumulatedCost } from '../lib/cost-file.js';

let root: string;
let target: string;
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-recurse-cost-')));
  target = join(root, 'cost');
  vi.stubEnv('RLM_COST_FILE', target);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const workerSource = `
  import fs from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  const [action, lock, release] = process.argv.slice(1);
  const rename = fs.renameSync;
  const mkdir = fs.mkdirSync;
  let reported = false;
  fs.mkdirSync = (file, options) => {
    try { return mkdir(file, options); }
    catch (error) {
      if (file === lock && error.code === 'EEXIST' && !reported) {
        reported = true;
        process.send('contended');
      }
      throw error;
    }
  };
  fs.renameSync = (from, to) => {
    if (to === process.env.RLM_COST_FILE && action === 'first') {
      process.send('before rename');
      const deadline = performance.now() + 8000;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(release)) {
        if (performance.now() >= deadline) throw new Error('test did not release writer');
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    if (to === process.env.RLM_COST_FILE && action === 'fail') throw new Error('injected publication failure');
    rename(from, to);
  };
  syncBuiltinESMExports();
  const { addAccumulatedCost } = await import('./lib/cost-file.ts');
  try {
    addAccumulatedCost(action === 'first' ? 1.125 : 2.5);
    if (action === 'fail') throw new Error('missing failure');
  } catch (error) {
    if (action !== 'fail' || error.message !== 'injected publication failure') throw error;
  }
`;

function writer(action: string, file: string, lock: string, release: string) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      workerSource,
      action,
      lock,
      release,
    ],
    {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, RLM_COST_FILE: file },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      timeout: 12000,
    }
  );
  const done = once(child, 'close');
  async function stop() {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await done;
  }
  return { child, done, stop };
}

it('merges actual concurrent additions and keeps the old total visible until rename', async ({
  onTestFinished,
}) => {
  writeFileSync(target, '0.250000');
  const canSymlink = process.platform !== 'win32';
  const alias = canSymlink ? join(root, 'alias') : target;
  if (canSymlink) {
    chmodSync(target, 0o640);
    symlinkSync('cost', alias);
  }
  const lock = `${target}.lock`;
  const release = join(root, 'release');
  const a = writer('first', target, lock, release);
  onTestFinished(a.stop);
  const [beforeRename] = await once(a.child, 'message', { signal: AbortSignal.timeout(7000) });
  expect(beforeRename).toBe('before rename');
  const b = writer('second', alias, lock, release);
  onTestFinished(b.stop);
  const [contended] = await once(b.child, 'message', { signal: AbortSignal.timeout(7000) });
  expect(contended).toBe('contended');
  expect(loadAccumulatedCost()).toBe(0.25);
  expect(readFileSync(alias, 'utf-8')).toBe('0.250000');
  expect(existsSync(lock)).toBe(true);
  writeFileSync(release, '');
  expect(await Promise.all([a.done, b.done])).toEqual([
    [0, null],
    [0, null],
  ]);
  expect(readFileSync(alias, 'utf-8')).toBe('3.875000');
  if (canSymlink) {
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o640);
  }
  expect(readdirSync(root).sort()).toEqual(
    canSymlink ? ['alias', 'cost', 'release'] : ['cost', 'release']
  );
}, 15000);

it(
  'creates a missing target through a dangling symlink and retains six decimal places',
  { skip: process.platform === 'win32' },
  () => {
    const alias = join(root, 'alias');
    symlinkSync('cost', alias);
    vi.stubEnv('RLM_COST_FILE', alias);
    addAccumulatedCost(0.1234564);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('0.123456');
  }
);

it.each(['', '0.25 USD\n', 'Infinity', '0xff', '1e999'])(
  'leaves malformed cost bytes (%j) unchanged',
  (malformed) => {
    writeFileSync(target, malformed);
    expect(() => addAccumulatedCost(1)).toThrow(/Malformed cost file.*Repair the total/);
    expect(readFileSync(target, 'utf-8')).toBe(malformed);
    expect(readdirSync(root)).toEqual(['cost']);
  }
);

it('cleans up only its own temp file after a failed publication', async ({ onTestFinished }) => {
  writeFileSync(target, '1.000000');
  const unrelated = join(root, '.atomic-other.tmp');
  writeFileSync(unrelated, 'leave me alone');
  const failing = writer('fail', target, `${target}.lock`, '');
  onTestFinished(failing.stop);
  expect(await failing.done).toEqual([0, null]);
  expect(readFileSync(target, 'utf-8')).toBe('1.000000');
  expect(readFileSync(unrelated, 'utf-8')).toBe('leave me alone');
  expect(readdirSync(root).sort()).toEqual(['.atomic-other.tmp', 'cost']);
});
