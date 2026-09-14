import { env, exports } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { VerifiedHelloParams } from "../src/deployment";
import { MODEL_ID } from "../src/hello";

describe("local durable Hello Agent", () => {
  const guarded = (name = "世界"): VerifiedHelloParams => ({
    kind: "verified-hello",
    expected: {
      workerVersion: env.CF_VERSION.id,
      sourceCommit: env.SOURCE_COMMIT,
      buildVersion: env.BUILD_VERSION,
    },
    hello: { name },
  });

  it.each(["workerVersion", "sourceCommit", "buildVersion"] as const)(
    "rejects a stale %s in the actual inference instance without model mocks",
    async (field) => {
      const id = crypto.randomUUID();
      const params = guarded();
      params.expected[field] =
        field === "workerVersion"
          ? crypto.randomUUID()
          : field === "sourceCommit"
            ? "a".repeat(40)
            : "old";
      await using instance = await introspectWorkflowInstance(env.HELLO_AGENT, id);
      await env.HELLO_AGENT.create({ id, params });
      await instance.waitForStatus("complete");
      expect(await instance.waitForStepResult({ name: "admit-deployment" })).toMatchObject({
        accepted: false,
      });
      expect(await instance.getOutput()).toMatchObject({
        kind: "deployment-rejected",
        runId: id,
        expected: params.expected,
        modelCalls: 0,
        workerVersion: env.CF_VERSION.id,
      });
    },
  );

  it.each(["request-tool", "finish-greeting"])(
    "rechecks identity inside %s even if replayed admission was accepted",
    async (modelStep) => {
      const id = crypto.randomUUID();
      const params = guarded();
      params.expected.workerVersion = crypto.randomUUID();
      await using instance = await introspectWorkflowInstance(env.HELLO_AGENT, id);
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult(
          { name: "admit-deployment" },
          {
            accepted: true,
            actual: { runId: id, ...params.expected },
            expected: params.expected,
          },
        );
        if (modelStep === "finish-greeting") {
          await modifier.mockStepResult(
            { name: "request-tool" },
            { params: params.hello, callId: "call_hello_1" },
          );
        }
      });
      await env.HELLO_AGENT.create({ id, params });
      await instance.waitForStatus("errored");
      // The local engine wraps a step's NonRetryableError in a generic terminal
      // message. Ordinary AI binding/adapter failures are not NonRetryableError.
      expect((await instance.getError()).message).toContain("NonRetryableError");
      await expect(instance.waitForStepResult({ name: modelStep })).rejects.toThrow();
    },
  );

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
    await env.HELLO_AGENT.create({ id, params: guarded() });
    await instance.waitForStatus("complete");
    expect(await instance.waitForStepResult({ name: "say-hello" })).toBe("Hello, 世界!");
    expect(await instance.getOutput()).toMatchObject({
      runId: id,
      admission: {
        accepted: true,
        expected: guarded().expected,
        actual: { runId: id, ...guarded().expected },
      },
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
