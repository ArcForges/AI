// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { type HelloParams, isRecord, MODEL_ID, parseParams, sayHello, TOOL_NAME } from "./hello";
import { finishGreeting, requestTool } from "./model";

type WorkflowParams = HelloParams | { kind: "deployment-probe" };

export interface Env {
  AI: Ai;
  HELLO_AGENT: Workflow<WorkflowParams>;
  BUILD_VERSION: string;
  SOURCE_COMMIT: string;
  CF_VERSION: { id: string };
}

// A possibly dispatched model call must never be repeated automatically.
const MODEL_STEP = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
  timeout: "90 seconds",
} as const;

export class HelloAgentWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  override async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const identity = {
      runId: event.instanceId,
      buildVersion: this.env.BUILD_VERSION,
      sourceCommit: this.env.SOURCE_COMMIT,
      workerVersion: this.env.CF_VERSION.id,
    };
    // This private deployment probe returns before any model or tool step.
    // Earlier versions reject its payload because it contains no Hello name.
    if (
      isRecord(event.payload) &&
      Object.keys(event.payload).length === 1 &&
      "kind" in event.payload &&
      event.payload.kind === "deployment-probe"
    ) {
      return { kind: "deployment-probe" as const, ...identity, modelCalls: 0 as const };
    }
    let params: HelloParams;
    try {
      params = parseParams(event.payload);
    } catch {
      throw new NonRetryableError("Invalid Hello Agent input; no model call was admitted.");
    }
    const proposal = await step.do("request-tool", MODEL_STEP, () =>
      requestTool(this.env.AI, params),
    );
    const toolMessage = await step.do("say-hello", async () => sayHello(proposal.params));
    const message = await step.do("finish-greeting", MODEL_STEP, () =>
      finishGreeting(this.env.AI, proposal, toolMessage),
    );
    return {
      ...identity,
      model: MODEL_ID,
      modelCalls: 2,
      tool: TOOL_NAME,
      toolMessage,
      message,
    };
  }
}

export default {
  fetch(request, env): Response {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }
    return Response.json({
      service: "arcforges-ai-hello",
      version: env.BUILD_VERSION,
      sourceCommit: env.SOURCE_COMMIT,
      inferenceVerified: false,
    });
  },
} satisfies ExportedHandler<Env>;
