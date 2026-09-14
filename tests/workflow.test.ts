import { env, exports } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MODEL_ID } from "../src/hello";

describe("local durable Hello Agent", () => {
  it("reports deployment identity without entering a model or tool step", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.HELLO_AGENT, id);
    await env.HELLO_AGENT.create({ id, params: { kind: "deployment-probe" } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({
      kind: "deployment-probe",
      runId: id,
      buildVersion: env.BUILD_VERSION,
      sourceCommit: env.SOURCE_COMMIT,
      workerVersion: env.CF_VERSION.id,
      modelCalls: 0,
    });
  });

  it("executes the real tool between explicit mocked model steps", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.HELLO_AGENT, id);
    await instance.modify(async (modifier) => {
      await modifier.mockStepResult(
        { name: "request-tool" },
        { params: { name: "世界" }, callId: "call_hello_1" },
      );
      await modifier.mockStepResult({ name: "finish-greeting" }, "Hello, 世界!");
    });
    await env.HELLO_AGENT.create({ id, params: { name: "世界" } });
    await instance.waitForStatus("complete");
    expect(await instance.waitForStepResult({ name: "say-hello" })).toBe("Hello, 世界!");
    expect(await instance.getOutput()).toMatchObject({
      runId: id,
      model: MODEL_ID,
      modelCalls: 2,
      tool: "say_hello",
      toolMessage: "Hello, 世界!",
      message: "Hello, 世界!",
    });
    const duplicate = await env.HELLO_AGENT.create({ id, params: { name: "world" } });
    expect(duplicate.id).toBe(id);
    expect(await instance.getOutput()).toMatchObject({ toolMessage: "Hello, 世界!" });
  });

  it("fails a possibly dispatched model step without automatically repeating it", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.HELLO_AGENT, id);
    await instance.modify(async (modifier) => {
      await modifier.disableRetryDelays();
      await modifier.mockStepError(
        { name: "request-tool" },
        new Error("injected-model-failure"),
        1,
      );
    });
    await env.HELLO_AGENT.create({ id, params: { name: "World" } });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toContain("injected-model-failure");
  });

  it("rejects invalid input before entering any model step", async () => {
    const id = crypto.randomUUID();
    await using instance = await introspectWorkflowInstance(env.HELLO_AGENT, id);
    await env.HELLO_AGENT.create({ id, params: { name: "" } });
    await instance.waitForStatus("errored");
    expect((await instance.getError()).message).toContain("NonRetryableError");
  });

  it("exposes only local health, with no unauthenticated inference endpoint", async () => {
    const response = await exports.default.fetch("https://local.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "arcforges-ai-hello",
      inferenceVerified: false,
    });
    expect(
      (await exports.default.fetch("https://local.test/hello", { method: "POST" })).status,
    ).toBe(404);
  });
});
