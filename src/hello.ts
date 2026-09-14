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

function responseOutput(value: unknown): unknown[] {
  if (
    !isRecord(value) ||
    value.status !== "completed" ||
    value.error ||
    !Array.isArray(value.output) ||
    value.output.length > 16
  ) {
    throw new Error("Expected a completed, bounded Responses API result.");
  }
  return value.output;
}

export function parseToolResponse(value: unknown, expected: HelloParams): ToolProposal {
  const calls = responseOutput(value).filter(
    (item) => isRecord(item) && item.type === "function_call",
  );
  if (calls.length !== 1) {
    throw new Error("The model must request exactly one say_hello tool.");
  }
  const tool = calls[0];
  if (
    !isRecord(tool) ||
    tool.name !== TOOL_NAME ||
    typeof tool.call_id !== "string" ||
    !/^[\w-]{1,256}$/u.test(tool.call_id) ||
    typeof tool.arguments !== "string" ||
    tool.arguments.length > 2048
  ) {
    throw new Error("Unsupported tool proposal.");
  }
  const params = parseParams(JSON.parse(tool.arguments));
  if (params.name !== expected.name) {
    throw new Error("The tool must preserve the supplied name.");
  }
  return { params, callId: tool.call_id };
}

export function parseFinalResponse(value: unknown): string {
  const text: string[] = [];
  for (const item of responseOutput(value)) {
    if (!isRecord(item)) throw new Error("Malformed response item.");
    if (item.type === "reasoning") continue;
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
      throw new Error("Expected final text without further tools.");
    }
    for (const part of item.content) {
      if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
        throw new Error("Expected text, not a refusal or another content type.");
      }
      text.push(part.text);
    }
  }
  const message = text.join("\n");
  if (!message.trim() || message.length > 4096) throw new Error("Invalid final text length.");
  return message;
}
