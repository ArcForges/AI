// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { type HelloParams, MODEL_ID, parseParams, sayHello, TOOL_NAME } from "./hello";
import { finishGreeting, requestTool } from "./model";

export interface Env {
  AI: Ai;
  HELLO_AGENT: Workflow<HelloParams>;
  BUILD_VERSION: string;
  SOURCE_COMMIT: string;
  CF_VERSION: { id: string };
}

// A possibly dispatched model call must never be repeated automatically.
const MODEL_STEP = {
  retries: { limit: 0, delay: "1 second", backoff: "constant" },
  timeout: "90 seconds",
} as const;

export class HelloAgentWorkflow extends WorkflowEntrypoint<Env, HelloParams> {
  override async run(event: WorkflowEvent<HelloParams>, step: WorkflowStep) {
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
      runId: event.instanceId,
      buildVersion: this.env.BUILD_VERSION,
      sourceCommit: this.env.SOURCE_COMMIT,
      workerVersion: this.env.CF_VERSION.id,
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
