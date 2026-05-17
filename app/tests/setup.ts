import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { __resetDriverForTests } from '../src/lib/db/driver';
import { __resetReposForTests } from '../src/lib/db/repos';

// Wipe the localStorage-backed dev DB between tests so each spec starts clean.
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.clear();
  __resetDriverForTests();
  __resetReposForTests();
});

// Stub Tauri detection so the SQL driver picks the browser shim.
if (typeof window !== 'undefined') {
  (window as any).__TAURI__ = undefined;
}
