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
  const call = toolResponse("ArcForges").output[0];

  it("accepts one exact allowed proposal", () => {
    expect(parseToolResponse(toolResponse("ArcForges"), expected)).toEqual({
      params: expected,
      callId: "call_hello_1",
    });
  });

  it.each([
    {},
    { status: "completed", output: [] },
    { status: "completed", output: [call, call] },
    { status: "completed", output: [{ ...call, name: "execute_shell" }] },
    toolResponse("other"),
    { status: "completed", output: [{ ...call, arguments: "broken JSON" }] },
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
      { ...textResponse(), status: "incomplete" },
    ]) {
      expect(() => parseFinalResponse(response)).toThrow();
    }
  });
});
