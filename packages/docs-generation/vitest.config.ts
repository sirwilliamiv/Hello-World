import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A headless Chromium render is slower than a unit test and is deliberately not
    // mocked — determinism claims about PDF bytes are worth nothing if the PDF is fake.
    testTimeout: 60_000,
  },
})
