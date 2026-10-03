import { defineConfig } from "vitest/config";

const ci = Boolean(process.env.CI);

export default defineConfig({
  test: {
    environment: "node",
    reporters: ci
      ? ["default", ["junit", { outputFile: "./test-results/junit.xml" }]]
      : ["default"],
  },
});
