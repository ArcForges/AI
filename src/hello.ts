// SPDX-License-Identifier: AGPL-3.0-only
import { SayHelloRequestSchema, SayHelloResponseSchema } from "@arcforges/proto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type ModelPhase, responseFailure } from "./model-diagnostics";

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

function completionMessage(value: unknown, phase: ModelPhase) {
  if (!isRecord(value)) throw responseFailure(phase, "RESPONSE_SHAPE", value);
  if (value.error) throw responseFailure(phase, "RESPONSE_ERROR", value);
  if (!Array.isArray(value.choices) || value.choices.length !== 1) {
    throw responseFailure(phase, "CHOICE_COUNT", value);
  }
  const choice = value.choices[0];
  if (!isRecord(choice)) throw responseFailure(phase, "CHOICE_SHAPE", value);
  if (!isRecord(choice.message)) throw responseFailure(phase, "MESSAGE_SHAPE", value);
  if (choice.message.role !== "assistant") throw responseFailure(phase, "MESSAGE_ROLE", value);
  if (choice.message.refusal) throw responseFailure(phase, "REFUSAL", value);
  if (choice.message.function_call) throw responseFailure(phase, "LEGACY_FUNCTION_CALL", value);
  if (choice.finish_reason === "length" || choice.finish_reason === "model_length") {
    throw responseFailure(phase, "OUTPUT_TRUNCATED", value);
  }
  if (choice.finish_reason === "content_filter") {
    throw responseFailure(phase, "CONTENT_FILTERED", value);
  }
  if (choice.finish_reason !== (phase === "request-tool" ? "tool_calls" : "stop")) {
    throw responseFailure(phase, "FINISH_REASON", value);
  }
  return choice.message;
}

export function parseToolResponse(value: unknown, expected: HelloParams): ToolProposal {
  const calls = completionMessage(value, "request-tool").tool_calls;
  if (!Array.isArray(calls) || calls.length !== 1) {
    throw responseFailure("request-tool", "TOOL_COUNT", value);
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
    throw responseFailure("request-tool", "TOOL_SHAPE", value);
  }
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(tool.function.arguments);
  } catch {
    throw responseFailure("request-tool", "TOOL_ARGUMENTS_JSON", value);
  }
  let params: HelloParams;
  try {
    params = parseParams(argumentsValue);
  } catch {
    throw responseFailure("request-tool", "TOOL_ARGUMENTS_INVALID", value);
  }
  if (params.name !== expected.name) {
    throw responseFailure("request-tool", "TOOL_NAME_CHANGED", value);
  }
  return { params, callId: tool.id };
}

export function parseFinalResponse(value: unknown): string {
  const message = completionMessage(value, "finish-greeting");
  if (
    message.tool_calls != null &&
    (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)
  ) {
    throw responseFailure("finish-greeting", "FINAL_TOOL_CALLS", value);
  }
  const text = message.content;
  if (typeof text !== "string" || !text.trim() || text.length > 4096) {
    throw responseFailure("finish-greeting", "FINAL_TEXT", value);
  }
  return text;
}
