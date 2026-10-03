import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

function readRootEnv(name: string): string | undefined {
  if (process.env[name]?.trim()) {
    return process.env[name];
  }

  try {
    const text = readFileSync(
      fileURLToPath(new URL("../.env", import.meta.url)),
      "utf8",
    );
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.startsWith(`${name}=`)) {
        continue;
      }
      return trimmed.slice(name.length + 1).trim();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

const apiPort = Number(readRootEnv("PORT") ?? 3001);
const clientOrigin = readRootEnv("CLIENT_ORIGIN") ?? "http://localhost:5173";
let clientPort = 5173;
try {
  clientPort = Number(new URL(clientOrigin).port || 5173);
} catch {
  clientPort = 5173;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.VITE_DEV_PORT ?? clientPort),
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
