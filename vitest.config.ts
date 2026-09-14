import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.json" }, remoteBindings: false })],
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 },
});
