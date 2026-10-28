import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: { LOG_LEVEL: "silent" },
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    coverage: { include: ["src/**"], thresholds: { lines: 80 } },
  },
});
