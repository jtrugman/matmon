import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Capture the short git SHA at build time. Best-effort; defaults to 'dev' when
// we're not in a git tree (e.g. CI shallow checkout without history, sandbox).
let gitSha = 'dev';
try {
  gitSha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* leave as 'dev' */
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_GIT_SHA__: JSON.stringify(gitSha),
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
