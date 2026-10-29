import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { buildDefines } from "./build-info";

// Wrangler config used for dev and build: $WRANGLER_CONFIG, else the git-ignored wrangler.local.jsonc (your own
// domain, vars...; see wrangler.local.example.jsonc), else the generic wrangler.jsonc. The build writes the resolved
// config to dist/postflare/wrangler.json and `wrangler deploy` picks that one up (via .wrangler/deploy/config.json).
const configPath =
  process.env.WRANGLER_CONFIG || (existsSync(new URL("./wrangler.local.jsonc", import.meta.url)) ? "./wrangler.local.jsonc" : "./wrangler.jsonc");

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ configPath })],
  // __POSTFLARE_VERSION__ / __POSTFLARE_COMMIT__ for the Worker and the app (shared/version.ts).
  define: buildDefines(),
  resolve: {
    alias: { "@shared": fileURLToPath(new URL("./shared", import.meta.url)) },
  },
});
