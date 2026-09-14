import { describe, expect, it } from "vitest";
import { parseFinalResponse, parseParams, parseToolResponse, sayHello } from "../src/hello";
import { textResponse, toolResponse } from "./fixtures";

describe("published Contracts greeting", () => {
  it("preserves Unicode and whitespace through published protobuf serialization", () => {
    expect(sayHello({ name: " 世界 👋 " })).toBe("Hello,  世界 👋 !");
  });

  it.each([
    {},
    { name: "" },
    { name: "x", extra: true },
    { name: "a\n" },
    { name: "x".repeat(81) },
  ])("rejects invalid or oversized input %j", (input) =>
    expect(() => parseParams(input)).toThrow(),
  );
});

describe("model output boundaries", () => {
  const expected = { name: "ArcForges" };
  const choice = toolResponse("ArcForges").choices[0];
  const call = choice.message.tool_calls[0];
  const withCalls = (calls: unknown[]) => ({
    choices: [{ ...choice, message: { ...choice.message, tool_calls: calls } }],
  });

  it("accepts one exact allowed proposal", () => {
    expect(parseToolResponse(toolResponse("ArcForges"), expected)).toEqual({
      params: expected,
      callId: "call_hello_1",
    });
  });

  it.each([
    {},
    withCalls([]),
    withCalls([call, call]),
    withCalls([{ ...call, function: { ...call.function, name: "execute_shell" } }]),
    toolResponse("other"),
    withCalls([{ ...call, function: { ...call.function, arguments: "broken JSON" } }]),
    { choices: [choice, choice] },
    { choices: [{ ...choice, finish_reason: "length" }] },
    textResponse(JSON.stringify({ name: "say_hello", arguments: { name: "ArcForges" } })),
  ])("rejects unsupported or malformed proposals %j", (response) => {
    expect(() => parseToolResponse(response, expected)).toThrow();
  });

  it("accepts final text but prevents a third model/tool iteration", () => {
    expect(parseFinalResponse(textResponse("Hello, ArcForges!"))).toBe("Hello, ArcForges!");
    for (const response of [
      null,
      {},
      textResponse(" "),
      textResponse("x".repeat(4097)),
      toolResponse(),
      { choices: [{ ...textResponse().choices[0], finish_reason: "length" }] },
      {
        choices: [
          {
            ...textResponse().choices[0],
            message: { ...textResponse().choices[0].message, refusal: "refused" },
          },
        ],
      },
      {
        choices: [
          {
            ...textResponse().choices[0],
            message: { ...textResponse().choices[0].message, tool_calls: [call] },
          },
        ],
      },
    ]) {
      expect(() => parseFinalResponse(response)).toThrow();
    }
  });
});
