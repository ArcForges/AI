// SPDX-License-Identifier: AGPL-3.0-only
import { SayHelloRequestSchema, SayHelloResponseSchema } from "@arcforges/proto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

export const MODEL_ID = "@cf/openai/gpt-oss-20b" as const;
export const TOOL_NAME = "say_hello";

export interface HelloParams {
  name: string;
}

export interface ToolProposal {
  params: HelloParams;
  callId: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseParams(value: unknown): HelloParams {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    [...value.name].length > 80 ||
    new TextEncoder().encode(value.name).byteLength > 256 ||
    [...value.name].some((character) => character.charCodeAt(0) < 32 || character === "\u007f")
  ) {
    throw new Error("Expected only a nonempty name, at most 80 characters / 256 UTF-8 bytes.");
  }
  return { name: value.name };
}

export function sayHello(params: HelloParams): string {
  const request = create(SayHelloRequestSchema, parseParams(params));
  const decoded = fromBinary(SayHelloRequestSchema, toBinary(SayHelloRequestSchema, request));
  const response = create(SayHelloResponseSchema, { message: `Hello, ${decoded.name}!` });
  return fromBinary(SayHelloResponseSchema, toBinary(SayHelloResponseSchema, response)).message;
}

function completionMessage(value: unknown, finishReason: "tool_calls" | "stop") {
  if (
    !isRecord(value) ||
    value.error ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  ) {
    throw new Error("Expected one Chat Completions choice.");
  }
  const choice = value.choices[0];
  if (
    !isRecord(choice) ||
    choice.finish_reason !== finishReason ||
    !isRecord(choice.message) ||
    choice.message.role !== "assistant" ||
    choice.message.refusal ||
    choice.message.function_call
  ) {
    throw new Error("Expected a completed assistant message without refusal or legacy tools.");
  }
  return choice.message;
}

export function parseToolResponse(value: unknown, expected: HelloParams): ToolProposal {
  const calls = completionMessage(value, "tool_calls").tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) {
    throw new Error("The model must request exactly one say_hello tool.");
  }
  const tool = calls[0];
  if (
    !isRecord(tool) ||
    tool.type !== "function" ||
    !isRecord(tool.function) ||
    tool.function.name !== TOOL_NAME ||
    typeof tool.id !== "string" ||
    !/^[\w-]{1,256}$/u.test(tool.id) ||
    typeof tool.function.arguments !== "string" ||
    tool.function.arguments.length > 2048
  ) {
    throw new Error("Unsupported tool proposal.");
  }
  const params = parseParams(JSON.parse(tool.function.arguments));
  if (params.name !== expected.name) {
    throw new Error("The tool must preserve the supplied name.");
  }
  return { params, callId: tool.id };
}

export function parseFinalResponse(value: unknown): string {
  const message = completionMessage(value, "stop");
  if (
    message.tool_calls != null &&
    (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)
  ) {
    throw new Error("Expected final text without further tools.");
  }
  const text = message.content;
  if (typeof text !== "string" || !text.trim() || text.length > 4096) {
    throw new Error("Invalid final text length.");
  }
  return text;
}
