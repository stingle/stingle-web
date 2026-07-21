import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/live-*.test.ts"],
    testTimeout: 120_000,
    sequence: { concurrent: false },
  },
});
