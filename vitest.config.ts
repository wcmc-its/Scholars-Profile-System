import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    pool: "forks",
    poolOptions: {
      forks: { maxForks: 4, minForks: 1 },
    },
    environment: "jsdom",
    globals: true,
    // Raised from the 5000ms default so a waitFor that consumes its widened
    // 5000ms asyncUtilTimeout (tests/setup.ts) on a CPU-starved fork doesn't
    // trip the per-test timeout first (#652).
    testTimeout: 15000,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    exclude: ["tests/e2e/**", "node_modules/**", ".next/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // The `server-only` / `client-only` marker packages are build-time guards
      // with no runtime behaviour; Next aliases them away during bundling. Plain
      // Vitest has no bundler to resolve them, so a bare `import "server-only"`
      // (e.g. lib/auth/session-server.ts, pulled in via lib/edit/request.ts)
      // would fail suite collection. Alias both to a no-op stub (#637).
      "server-only": path.resolve(__dirname, "tests/stubs/empty-module.ts"),
      "client-only": path.resolve(__dirname, "tests/stubs/empty-module.ts"),
    },
  },
});
