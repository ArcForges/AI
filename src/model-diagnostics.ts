// SPDX-License-Identifier: AGPL-3.0-only
// This dependency-free codec is shared by the Worker and Node 24 release tooling.
// Never serialize model text, reasoning, tool arguments or arbitrary provider errors.
const PREFIX = "AF_MODEL_FAILURE_V1 ";
const PHASES = ["request-tool", "finish-greeting"] as const;
const RESPONSE_CODES = [
  "RESPONSE_SHAPE",
  "RESPONSE_ERROR",
  "CHOICE_COUNT",
  "CHOICE_SHAPE",
  "MESSAGE_SHAPE",
  "MESSAGE_ROLE",
  "REFUSAL",
  "LEGACY_FUNCTION_CALL",
  "OUTPUT_TRUNCATED",
  "CONTENT_FILTERED",
  "FINISH_REASON",
  "TOOL_COUNT",
  "TOOL_SHAPE",
  "TOOL_ARGUMENTS_JSON",
  "TOOL_ARGUMENTS_INVALID",
  "TOOL_NAME_CHANGED",
  "FINAL_TOOL_CALLS",
  "FINAL_TEXT",
] as const;
const FINISH_REASONS = ["tool_calls", "stop", "length", "model_length", "content_filter", "error"];
const ROLES = ["assistant", "user", "system", "tool"];
const PROVIDER_ERRORS = ["InferenceUpstreamError", "AiInternalError", "AbortError", "TimeoutError"];

export type ModelPhase = (typeof PHASES)[number];
type ResponseCode = (typeof RESPONSE_CODES)[number];
type ResponseSummary = {
  choiceCount: number | null;
  finishReason: string;
  role: string;
  toolCallCount: number | null;
  contentChars: number | null;
  refusal: boolean;
  legacyFunctionCall: boolean;
  completionTokens: number | null;
};
type ProviderSummary = { name: string; httpStatus: number | null; code: number | null };
export type ModelDiagnostic =
  | { phase: ModelPhase; code: ResponseCode; response: ResponseSummary }
  | { phase: ModelPhase; code: "PROVIDER_CALL_FAILED"; provider: ProviderSummary };

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function label(value: unknown, allowed: readonly string[]): string {
  return value == null
    ? "missing"
    : typeof value === "string" && allowed.includes(value)
      ? value
      : "other";
}

function responseSummary(value: unknown): ResponseSummary {
  const response = record(value);
  const choice = record(Array.isArray(response.choices) ? response.choices[0] : null);
  const message = record(choice.message);
  return {
    choiceCount: Array.isArray(response.choices) ? response.choices.length : null,
    finishReason: label(choice.finish_reason, FINISH_REASONS),
    role: label(message.role, ROLES),
    toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : null,
    contentChars: typeof message.content === "string" ? message.content.length : null,
    refusal: Boolean(message.refusal),
    legacyFunctionCall: Boolean(message.function_call),
    completionTokens: count(record(response.usage).completion_tokens),
  };
}

export class ModelFailure extends Error {
  constructor(diagnostic: ModelDiagnostic) {
    super(PREFIX + JSON.stringify(diagnostic));
    this.name = "ModelFailure";
  }
}

export function responseFailure(
  phase: ModelPhase,
  code: ResponseCode,
  value: unknown,
): ModelFailure {
  return new ModelFailure({ phase, code, response: responseSummary(value) });
}

export async function modelCall<T>(phase: ModelPhase, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const provider = record(error);
    // Some Workers AI errors expose only a numeric prefix, e.g. "5006: ...".
    const prefixCode =
      typeof provider.message === "string" ? /^(\d{1,6}):/u.exec(provider.message)?.[1] : undefined;
    const status = count(provider.status);
    throw new ModelFailure({
      phase,
      code: "PROVIDER_CALL_FAILED",
      provider: {
        name: label(provider.name, PROVIDER_ERRORS),
        httpStatus: status !== null && status >= 100 && status <= 599 ? status : null,
        code: count(provider.code) ?? (prefixCode === undefined ? null : Number(prefixCode)),
      },
    });
  }
}

// Workflow errors cross a remote trust boundary. Rebuild the allowed fields;
// never print the raw error message or accept arbitrary strings/extra fields.
export function readModelFailure(message: unknown): ModelDiagnostic | null {
  if (typeof message !== "string" || message.length > 4096) return null;
  const encoded = message.replace(/^(?:ModelFailure|Error): /u, "");
  if (!encoded.startsWith(PREFIX)) return null;
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(encoded.slice(PREFIX.length)));
  } catch {
    return null;
  }
  if (!PHASES.includes(value.phase as ModelPhase)) return null;
  const phase = value.phase as ModelPhase;
  if (value.code === "PROVIDER_CALL_FAILED") {
    const provider = record(value.provider);
    const status = count(provider.httpStatus);
    return {
      phase,
      code: value.code,
      provider: {
        name: label(provider.name, [...PROVIDER_ERRORS, "missing", "other"]),
        httpStatus: status !== null && status >= 100 && status <= 599 ? status : null,
        code: count(provider.code),
      },
    };
  }
  if (!RESPONSE_CODES.includes(value.code as ResponseCode)) return null;
  const response = record(value.response);
  return {
    phase,
    code: value.code as ResponseCode,
    response: {
      choiceCount: count(response.choiceCount),
      finishReason: label(response.finishReason, [...FINISH_REASONS, "missing", "other"]),
      role: label(response.role, [...ROLES, "missing", "other"]),
      toolCallCount: count(response.toolCallCount),
      contentChars: count(response.contentChars),
      refusal: response.refusal === true,
      legacyFunctionCall: response.legacyFunctionCall === true,
      completionTokens: count(response.completionTokens),
    },
  };
}
