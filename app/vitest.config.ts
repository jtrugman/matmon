import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // Match the build-time injection in vite.config.ts so component tests see
    // the same symbols.
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __APP_GIT_SHA__: JSON.stringify('test'),
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx', 'src/data.ts'],
    },
  },
});
