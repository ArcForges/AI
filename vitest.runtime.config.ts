import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

if (process.env.CI === "true") throw new Error("Workflow runtime tests are local opt-in only.");

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.json" }, remoteBindings: false })],
  test: { include: ["tests/workflow.test.ts"], testTimeout: 15000 },
});
