import { describe, expect, it } from "vitest";
import { parseFinalResponse, parseToolResponse } from "../src/hello";
import { readModelFailure } from "../src/model-diagnostics";
import { textResponse, toolResponse } from "./fixtures";

describe("safe model response diagnostics", () => {
  const choice = toolResponse().choices[0];
  const call = choice.message.tool_calls[0];
  const message = (fields: Record<string, unknown>) => ({
    choices: [{ ...choice, message: { ...choice.message, ...fields } }],
  });
  const args = (value: string) =>
    message({ tool_calls: [{ ...call, function: { ...call.function, arguments: value } }] });

  it.each([
    [null, "RESPONSE_SHAPE"],
    [{ error: "private-error" }, "RESPONSE_ERROR"],
    [{ choices: [] }, "CHOICE_COUNT"],
    [{ choices: [null] }, "CHOICE_SHAPE"],
    [{ choices: [{ ...choice, message: null }] }, "MESSAGE_SHAPE"],
    [message({ role: "private-role" }), "MESSAGE_ROLE"],
    [message({ refusal: "private-refusal" }), "REFUSAL"],
    [message({ function_call: { arguments: "private-arguments" } }), "LEGACY_FUNCTION_CALL"],
    [{ choices: [{ ...choice, finish_reason: "length" }] }, "OUTPUT_TRUNCATED"],
    [{ choices: [{ ...choice, finish_reason: "model_length" }] }, "OUTPUT_TRUNCATED"],
    [{ choices: [{ ...choice, finish_reason: "content_filter" }] }, "CONTENT_FILTERED"],
    [{ choices: [{ ...choice, finish_reason: "stop" }] }, "FINISH_REASON"],
    [textResponse('{"name":"say_hello","arguments":{"name":"World"}}'), "FINISH_REASON"],
    [message({ tool_calls: [] }), "TOOL_COUNT"],
    [message({ tool_calls: [call, call] }), "TOOL_COUNT"],
    [message({ tool_calls: [{ ...call, id: "private invalid id" }] }), "TOOL_SHAPE"],
    [args("private-invalid-json"), "TOOL_ARGUMENTS_JSON"],
    [args('{"name":"World","extra":"private-extra"}'), "TOOL_ARGUMENTS_INVALID"],
    [args('{"name":"private-different-name"}'), "TOOL_NAME_CHANGED"],
  ])("classifies an invalid tool response as %s / %s", (value, code) => {
    try {
      parseToolResponse(value, { name: "World" });
      expect.fail("An invalid response must not execute a tool.");
    } catch (error) {
      const diagnostic = readModelFailure((error as Error).message);
      expect(diagnostic).toMatchObject({ phase: "request-tool", code });
      expect((error as Error).message).not.toContain("private-");
    }
  });

  it("retains only bounded response metadata, including usage and completion reason", () => {
    const response = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "private-content",
            reasoning: "private-reasoning",
            tool_calls: [],
          },
        },
      ],
      usage: { completion_tokens: 32 },
    };
    try {
      parseToolResponse(response, { name: "World" });
      expect.fail("A prose response cannot replace a tool call.");
    } catch (error) {
      expect(readModelFailure((error as Error).message)).toEqual({
        phase: "request-tool",
        code: "FINISH_REASON",
        response: {
          choiceCount: 1,
          finishReason: "stop",
          role: "assistant",
          toolCallCount: 0,
          contentChars: 15,
          refusal: false,
          legacyFunctionCall: false,
          completionTokens: 32,
        },
      });
    }
  });

  it.each([
    [textResponse(" "), "FINAL_TEXT"],
    [
      {
        choices: [
          {
            ...textResponse().choices[0],
            message: { ...textResponse().choices[0].message, tool_calls: [call] },
          },
        ],
      },
      "FINAL_TOOL_CALLS",
    ],
  ])("classifies invalid final responses without using their text: %s / %s", (value, code) => {
    try {
      parseFinalResponse(value);
      expect.fail("Invalid final responses cannot pass.");
    } catch (error) {
      expect(readModelFailure((error as Error).message)).toMatchObject({
        phase: "finish-greeting",
        code,
      });
    }
  });

  it("filters untrusted remote fields and rejects unknown or oversized diagnostics", () => {
    const remote =
      "AF_MODEL_FAILURE_V1 " +
      JSON.stringify({
        phase: "request-tool",
        code: "FINISH_REASON",
        extra: "private-extra",
        response: {
          choiceCount: 1,
          finishReason: "private-reason",
          role: "private-role",
          contentChars: -1,
          completionTokens: "private-usage",
          content: "private-content",
        },
      });
    const diagnostic = readModelFailure(`ModelFailure: ${remote}`);
    expect(diagnostic).toMatchObject({
      response: {
        finishReason: "other",
        role: "other",
        contentChars: null,
        completionTokens: null,
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private-");
    for (const invalid of [
      null,
      "private-error",
      "AF_MODEL_FAILURE_V1 {",
      remote.repeat(30),
      remote.replace("FINISH_REASON", "private-code"),
      remote.replace("request-tool", "private-phase"),
    ]) {
      expect(readModelFailure(invalid)).toBeNull();
    }
  });
});
