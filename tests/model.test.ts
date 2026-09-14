import { describe, expect, it, vi } from "vitest";
import { MODEL_ID } from "../src/hello";
import { finishGreeting, requestTool } from "../src/model";
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
        max_output_tokens: 1024,
        stream: false,
        tools: [expect.objectContaining({ name: "say_hello" })],
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
    expect(request.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_hello_1",
      output: "Hello, World!",
    });
  });

  it("propagates provider failure without a retry or synthetic greeting", async () => {
    const run = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    await expect(requestTool({ run } as unknown as Ai, { name: "World" })).rejects.toThrow(
      "provider unavailable",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
