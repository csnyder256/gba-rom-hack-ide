import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: false,
    // jsdom rendering blocks the event loop. vitest 1.x never enforced a
    // timeout on blocked work, so some App tests only looked like they fit
    // the 5 s default; vitest 2+ enforces it. Under a full parallel run a
    // few take several seconds.
    testTimeout: 20_000,
  },
});
