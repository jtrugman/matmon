#!/usr/bin/env node
// Wraps Sindre Sorhus's `create-dmg` to produce a Matmon DMG from the .app
// bundle that `tauri build --bundles app` emits. Tauri 2's own DMG step
// (bundle_dmg.sh) currently fails on Apple Silicon, so we delegate just
// the DMG packaging here.
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');
const targetRoot = resolve(appRoot, 'src-tauri', 'target');
const candidates = [
  resolve(targetRoot, 'aarch64-apple-darwin', 'release', 'bundle', 'macos', 'Matmon.app'),
  resolve(targetRoot, 'x86_64-apple-darwin', 'release', 'bundle', 'macos', 'Matmon.app'),
  resolve(targetRoot, 'release', 'bundle', 'macos', 'Matmon.app'),
];
const appPath = candidates.find((p) => existsSync(p));
if (!appPath) {
  console.error('bundle-dmg: Matmon.app not found. Looked in:');
  for (const p of candidates) console.error('  ' + p);
  process.exit(1);
}
const outDir = resolve(targetRoot, 'release', 'bundle', 'dmg');
mkdirSync(outDir, { recursive: true });
console.log('bundle-dmg: packaging ' + appPath);
console.log('bundle-dmg: output dir ' + outDir);
// TODO: once enrolled in the Apple Developer Program, drop `--no-code-sign`
// and pass `--identity=<Developer ID Application: Your Name (TEAMID)>` so the
// DMG is signed and notarization-ready.
const args = ['create-dmg', '--overwrite', '--no-code-sign', appPath, outDir];
const result = spawnSync('npx', args, { cwd: appRoot, stdio: 'inherit' });
process.exit(result.status ?? 1);
