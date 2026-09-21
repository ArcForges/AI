import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/hello.test.ts", "tests/model.test.ts", "tests/model-diagnostics.test.ts"],
  },
});
