/**
 * Restore the executable bit on node-pty's `spawn-helper`.
 *
 * node-pty ships prebuilt binaries, and on macOS it does not spawn your shell
 * directly — it execs a small `spawn-helper` sitting next to the .node binding.
 * pnpm's extraction does not preserve that file's executable bit, so
 * `posix_spawnp` fails with EACCES and every terminal session dies at birth with
 * the singularly unhelpful message "posix_spawnp failed".
 *
 * This is a one-line fix that is impossible to guess from the error, so it runs
 * on every install rather than living in a README nobody reads.
 */

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = join(ROOT, 'node_modules/.pnpm');

if (existsSync(store)) {
  let fixed = 0;
  for (const entry of readdirSync(store)) {
    if (!entry.startsWith('node-pty@')) continue;
    const prebuilds = join(store, entry, 'node_modules/node-pty/prebuilds');
    if (!existsSync(prebuilds)) continue;
    for (const platform of readdirSync(prebuilds)) {
      const helper = join(prebuilds, platform, 'spawn-helper');
      if (!existsSync(helper)) continue;
      // 0o111 is the executable bits; only touch it when they are missing.
      if ((statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        fixed += 1;
      }
    }
  }
  if (fixed > 0) console.log(`fixed spawn-helper permissions (${fixed})`);
}
