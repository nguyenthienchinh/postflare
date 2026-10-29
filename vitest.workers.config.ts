import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { buildDefines } from "./build-info";

// Integration tests: the real Hono app against a real (local, in-memory) D1 and R2, inside workerd.
// Storage is isolated per test file; test files also build their own users/workspaces (unique emails).
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workers/wrangler.test.jsonc" } })],
  define: buildDefines(),
  test: {
    name: "workers",
    include: ["test/workers/**/*.test.ts"],
    // Vitest 5 defaults to clearing mock call history before every test; keep the Vitest 3/4 behaviour.
    clearMocks: false,
  },
});
