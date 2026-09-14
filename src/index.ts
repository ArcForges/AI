// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { matchesDeployment, parseWorkflowParams, type VerifiedHelloParams } from "./deployment";
import { type HelloParams, MODEL_ID, sayHello, TOOL_NAME } from "./hello";
import { finishGreeting, requestTool } from "./model";

type WorkflowParams = HelloParams | VerifiedHelloParams;

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
    const identity = () => ({
      runId: event.instanceId,
      buildVersion: this.env.BUILD_VERSION,
      sourceCommit: this.env.SOURCE_COMMIT,
      workerVersion: this.env.CF_VERSION.id,
    });
    let parsed: ReturnType<typeof parseWorkflowParams>;
    try {
      parsed = parseWorkflowParams(event.payload);
    } catch {
      throw new NonRetryableError("Invalid Hello Agent input; no model call was admitted.");
    }
    const { hello: params, expected } = parsed;
    // Persist the admission decision in THIS inference instance. A replay must
    // not rewrite an earlier accepted decision as a model-free rejection.
    const admission = expected
      ? await step.do("admit-deployment", { ...MODEL_STEP, timeout: "10 seconds" }, async () => {
          const actual = identity();
          return { accepted: matchesDeployment(actual, expected), actual, expected };
        })
      : undefined;
    if (admission && !admission.accepted) {
      return {
        kind: "deployment-rejected" as const,
        ...admission.actual,
        expected: admission.expected,
        modelCalls: 0 as const,
      };
    }
    const requireVersion = () => {
      if (expected && !matchesDeployment(identity(), expected)) {
        throw new NonRetryableError(
          "Deployment identity changed after admission; do not automatically restart this instance.",
        );
      }
    };
    const proposal = await step.do("request-tool", MODEL_STEP, () => {
      requireVersion();
      return requestTool(this.env.AI, params);
    });
    const toolMessage = await step.do("say-hello", async () => sayHello(proposal.params));
    const message = await step.do("finish-greeting", MODEL_STEP, () => {
      requireVersion();
      return finishGreeting(this.env.AI, proposal, toolMessage);
    });
    requireVersion();
    return {
      ...identity(),
      ...(admission ? { admission } : {}),
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
