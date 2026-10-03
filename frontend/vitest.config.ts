import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const ci = Boolean(process.env.CI);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    fileParallelism: false,
    reporters: ci
      ? [
          "default",
          ["junit", { outputFile: "./test-results/junit.xml" }],
          ["html", { outputFile: "./test-results/index.html", open: "never" }],
        ]
      : ["default"],
  },
});
