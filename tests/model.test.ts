import { describe, expect, it, vi } from "vitest";
import { MODEL_ID } from "../src/hello";
import { finishGreeting, requestTool } from "../src/model";
import { readModelFailure } from "../src/model-diagnostics";
import { textResponse, toolResponse } from "./fixtures";

describe("direct Workers AI adapter", () => {
  it("sends the selected model and a bounded single-tool declaration", async () => {
    const run = vi.fn().mockResolvedValue(toolResponse());
    const ai = { run } as unknown as Ai;
    expect(await requestTool(ai, { name: "World" })).toEqual({
      params: { name: "World" },
      callId: "call_hello_1",
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(
      MODEL_ID,
      expect.objectContaining({
        max_tokens: 1024,
        temperature: 0,
        reasoning_effort: "low",
        parallel_tool_calls: false,
        stream: false,
        messages: expect.any(Array),
        tool_choice: { type: "function", function: { name: "say_hello" } },
        tools: [
          expect.objectContaining({ function: expect.objectContaining({ name: "say_hello" }) }),
        ],
      }),
    );
  });

  it("passes the actual tool result to the final call without declaring more tools", async () => {
    const run = vi.fn().mockResolvedValue(textResponse());
    expect(
      await finishGreeting(
        { run } as unknown as Ai,
        { params: { name: "World" }, callId: "call_hello_1" },
        "Hello, World!",
      ),
    ).toBe("Hello, World!");
    const request = run.mock.calls[0]?.[1];
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBe("none");
    expect(request.temperature).toBe(0);
    expect(request.max_tokens).toBe(1024);
    expect(request.reasoning_effort).toBe("low");
    expect(run).toHaveBeenCalledTimes(1);
    expect(request.messages[2]).toMatchObject({
      role: "assistant",
      content: "",
      tool_calls: [expect.objectContaining({ id: "call_hello_1" })],
    });
    expect(request.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_hello_1",
      content: "Hello, World!",
    });
  });

  it.each(["request-tool", "finish-greeting"] as const)(
    "reports %s provider failure without leaking content or retrying",
    async (phase) => {
      const error = Object.assign(new Error("5006: private-provider-body"), {
        name: "InferenceUpstreamError",
        status: 400,
      });
      const run = vi.fn().mockRejectedValue(error);
      const ai = { run } as unknown as Ai;
      const invoke = () =>
        phase === "request-tool"
          ? requestTool(ai, { name: "World" })
          : finishGreeting(
              ai,
              { params: { name: "World" }, callId: "call_hello_1" },
              "Hello, World!",
            );
      try {
        await invoke();
        expect.fail("Provider failure must fail the step.");
      } catch (failure) {
        expect(failure).toBeInstanceOf(Error);
        const message = (failure as Error).message;
        expect(message).not.toContain("private-provider-body");
        expect(readModelFailure(message)).toEqual({
          phase,
          code: "PROVIDER_CALL_FAILED",
          provider: { name: "InferenceUpstreamError", httpStatus: 400, code: 5006 },
        });
      }
      expect(run).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["request-tool", "finish-greeting"] as const)(
    "does not retry or change protocols after %s returns an invalid response",
    async (phase) => {
      const run = vi.fn().mockResolvedValue({
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: "private-partial-result" },
          },
        ],
      });
      const ai = { run } as unknown as Ai;
      const invocation =
        phase === "request-tool"
          ? requestTool(ai, { name: "World" })
          : finishGreeting(
              ai,
              { params: { name: "World" }, callId: "call_hello_1" },
              "Hello, World!",
            );
      await expect(invocation).rejects.toThrow('"code":"OUTPUT_TRUNCATED"');
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
});
