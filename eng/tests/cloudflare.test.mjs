// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelCall, responseFailure } from "../../src/model-diagnostics.ts";
import {
  createApi,
  parseWorkerVersion,
  probe,
  validateLiveOutput,
  verifiedHelloParams,
  workflowFailure,
} from "../cloudflare.mjs";

const expected = {
  smokeProtocol: "verified-hello-v1",
  runId: "hello-11111111-1111-4111-8111-111111111111",
  workerVersion: "11111111-1111-4111-8111-111111111111",
  sourceCommit: "a".repeat(40),
  version: "0.1.0-ci.1.1",
};
const otherWorker = "22222222-2222-4222-8222-222222222222";
const completed = (runId = expected.runId) => ({
  status: "complete",
  output: {
    runId,
    ...verifiedHelloParams(expected).expected,
    admission: {
      accepted: true,
      expected: verifiedHelloParams(expected).expected,
      actual: { runId, ...verifiedHelloParams(expected).expected },
    },
    model: "@cf/openai/gpt-oss-20b",
    modelCalls: 2,
    tool: "say_hello",
    toolMessage: "Hello, ArcForges!",
    message: "Hello, ArcForges!",
  },
});
const rejected = (runId = expected.runId, actual = { workerVersion: otherWorker }) => ({
  status: "complete",
  params: verifiedHelloParams(expected),
  step_count: 1,
  steps: [{ name: "admit-deployment-1", success: true }],
  output: {
    kind: "deployment-rejected",
    runId,
    ...verifiedHelloParams(expected).expected,
    ...actual,
    expected: verifiedHelloParams(expected).expected,
    modelCalls: 0,
  },
});
const oldInputRejection = () => ({
  status: "errored",
  params: JSON.stringify(verifiedHelloParams(expected)),
  step_count: 0,
  steps: [],
  error: { message: "NonRetryableError: Invalid Hello Agent input; no model call was admitted." },
});

function fakeClock(timeoutMs = 100) {
  let clock = 0;
  return {
    pollMs: 1,
    timeoutMs,
    now: () => clock,
    wait: async () => {
      clock++;
    },
  };
}

test("a lost create response stops; resumption reads the same instance without another POST", async () => {
  const posts = [];
  const records = [];
  const api = async (_route, options) => {
    if (options?.method === "POST") {
      posts.push(options.body);
      assert.equal(records.at(-1).status, "submitting");
      throw new Error("simulated connection loss after submission");
    }
    return posts.length ? completed() : null;
  };
  await assert.rejects(
    probe(api, expected, { record: (state) => records.push(state) }),
    /connection loss/u,
  );
  const resumed = await probe(api, expected);
  assert.equal(resumed.runId, expected.runId);
  assert.deepEqual(posts, [{ instance_id: expected.runId, params: verifiedHelloParams(expected) }]);
});

test("only proven pre-model rejections advance to another guarded inference instance", async () => {
  const posts = [];
  const records = [];
  const observations = [
    () => oldInputRejection(),
    (id) => rejected(id),
    (id) => rejected(id, { sourceCommit: "b".repeat(40) }),
    (id) => rejected(id, { buildVersion: "old" }),
    (id) => completed(id),
  ];
  const output = await probe(
    async (route, options) => {
      if (options?.method === "POST") {
        posts.push(options.body);
        return { id: options.body.instance_id };
      }
      if (options?.allowMissing) return null;
      return observations[posts.length - 1](route.split("/").at(-1));
    },
    expected,
    { ...fakeClock(), record: (state) => records.push(state) },
  );
  assert.equal(output.runId, `${expected.runId}-5`);
  assert.equal(output.modelCalls, 2);
  assert.equal(posts.length, 5);
  assert(
    posts.every(
      (body) => JSON.stringify(body.params) === JSON.stringify(verifiedHelloParams(expected)),
    ),
  );
  assert.equal(new Set(posts.map((body) => body.instance_id)).size, posts.length);
  assert.equal(records.filter((state) => state.modelCalls === 0).length, 4);
});

test("a model-free probe from another instance cannot authorize inference", async () => {
  let calls = 0;
  await assert.rejects(
    probe(async () => {
      calls++;
      return {
        status: "complete",
        output: {
          kind: "deployment-probe",
          runId: expected.runId,
          ...verifiedHelloParams(expected).expected,
          modelCalls: 0,
        },
      };
    }, expected),
    /did not record deployment admission/u,
  );
  assert.equal(calls, 1);
});

test("a completed stale inference remains a failure and is never replaced", async () => {
  const status = completed();
  status.output.workerVersion = otherWorker;
  let calls = 0;
  await assert.rejects(
    probe(async () => {
      calls++;
      return status;
    }, expected),
    /another Worker version/u,
  );
  assert.equal(calls, 1);
});

test("a claimed zero-call rejection with a model step cannot cause another inference", async () => {
  const status = rejected();
  status.step_count = 2;
  status.steps.push({ name: "request-tool-1", success: true });
  let calls = 0;
  await assert.rejects(
    probe(async () => {
      calls++;
      return status;
    }, expected),
    /unexpected step history/u,
  );
  assert.equal(calls, 1);
});

test("missing or inconsistent rejection evidence fails closed", async () => {
  const badParams = rejected();
  badParams.params = { name: "ArcForges" };
  const failedAdmission = rejected();
  failedAdmission.steps[0].success = false;
  const missingSteps = oldInputRejection();
  delete missingSteps.step_count;
  const modelError = oldInputRejection();
  modelError.error.message = "Model timed out after dispatch";
  for (const status of [
    badParams,
    failedAdmission,
    missingSteps,
    modelError,
    { status: "terminated" },
  ]) {
    let calls = 0;
    await assert.rejects(
      probe(async () => {
        calls++;
        return status;
      }, expected),
    );
    assert.equal(calls, 1);
  }
});

test("a pending or timed-out instance never causes a replacement", async () => {
  const ids = new Set();
  await assert.rejects(
    probe(
      async (route, options) => {
        assert.notEqual(options?.method, "POST");
        ids.add(route);
        return { status: "running" };
      },
      expected,
      fakeClock(3),
    ),
    /SAME instance/u,
  );
  assert.equal(ids.size, 1);
});

test("admission has both a wall-clock limit and a total instance limit", async () => {
  for (const timeout of [3, 1000]) {
    const ids = new Set();
    await assert.rejects(
      probe(
        async (route, options) => {
          assert.notEqual(options?.method, "POST");
          ids.add(route);
          return rejected(route.split("/").at(-1));
        },
        expected,
        fakeClock(timeout),
      ),
      /admission limit reached/u,
    );
    assert.equal(ids.size, timeout === 3 ? 3 : 30);
  }
});

test("resuming after a pre-model rejection queries the already admitted next ID", async () => {
  const routes = [];
  const result = await probe(
    async (route, options) => {
      assert.notEqual(options?.method, "POST");
      routes.push(route);
      return route.endsWith(expected.runId) ? rejected() : completed(`${expected.runId}-2`);
    },
    expected,
    fakeClock(),
  );
  assert.equal(result.runId, `${expected.runId}-2`);
  assert.equal(routes.length, 2);
});

test("legacy deployment records cannot create a guarded replacement for an old paid smoke", async () => {
  await assert.rejects(
    probe(async () => assert.fail("No API access for legacy records"), {
      ...expected,
      smokeProtocol: undefined,
    }),
    /Legacy smoke record/u,
  );
});

test("real evidence requires native Worker identity and persisted admission identity", () => {
  const status = completed();
  assert.equal(
    validateLiveOutput({ ...status, output: JSON.stringify(status.output) }, expected).modelCalls,
    2,
  );
  status.output.admission.actual.workerVersion = otherWorker;
  assert.throws(() => validateLiveOutput(status, expected));
  assert.equal(
    parseWorkerVersion(`Current Version ID: ${expected.workerVersion}`),
    expected.workerVersion,
  );
  assert.throws(() => parseWorkerVersion("Uploaded but version confirmation was lost"));
});

test("API failures do not print credentials or arbitrary server response bodies", async () => {
  const api = createApi(
    { accountId: "a".repeat(32), token: "sensitive-test-value" },
    async () => new Response("sensitive-test-value", { status: 403 }),
  );
  await assert.rejects(
    api("/workflows/arcforges-ai-hello/instances"),
    (error) =>
      error.message.includes("HTTP 403") && !error.message.includes("sensitive-test-value"),
  );
});

test("model validation failures reach CI and evidence without another POST or raw model content", async () => {
  const error = responseFailure("request-tool", "FINISH_REASON", {
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: "private-content", tool_calls: [] },
      },
    ],
    usage: { completion_tokens: 32 },
  });
  const records = [];
  let reads = 0;
  const status = {
    status: "errored",
    error: { name: "Error", message: "private-wrapper-error" },
    step_count: 2,
    steps: [
      { name: "admit-deployment-1", success: true },
      {
        name: "request-tool-1",
        success: false,
        attempts: [{ success: false, error: { name: error.name, message: error.message } }],
      },
    ],
  };
  await assert.rejects(
    probe(
      async (_route, options) => {
        assert.notEqual(options?.method, "POST");
        reads++;
        return status;
      },
      expected,
      { record: (record) => records.push(record) },
    ),
    (failure) => {
      assert.match(failure.message, /FINISH_REASON/u);
      assert.match(failure.message, /request-tool-1/u);
      assert.match(failure.message, /possibly-incurred/u);
      assert.doesNotMatch(failure.message, /private-/u);
      return true;
    },
  );
  assert.equal(reads, 1);
  assert.deepEqual(records.at(-1).failure, {
    code: "FINISH_REASON",
    step: "request-tool-1",
    attempts: 1,
    modelStepsObserved: 1,
    modelUsage: "possibly-incurred",
    diagnostic: {
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
    },
  });
});

test("provider diagnostics survive Workflow serialization and distinguish a call error from validation", async () => {
  let error;
  try {
    await modelCall("finish-greeting", async () => {
      throw Object.assign(new Error("private-upstream-body"), { status: 429 });
    });
  } catch (caught) {
    error = { name: caught.name, message: caught.message };
  }
  const failure = workflowFailure({
    status: "errored",
    error,
    steps: [
      { name: "request-tool-1", success: true },
      { name: "finish-greeting-1", success: false, attempts: [{ error }] },
    ],
  });
  assert.equal(failure.code, "PROVIDER_CALL_FAILED");
  assert.equal(failure.step, "finish-greeting-1");
  assert.equal(failure.modelStepsObserved, 2);
  assert.equal(failure.diagnostic.provider.httpStatus, 429);
  assert.doesNotMatch(JSON.stringify(failure), /private-/u);
});

test("legacy errors remain identifiable without inventing their missing response details", () => {
  const failure = workflowFailure({
    status: "errored",
    error: { message: "Expected a completed assistant message without refusal or legacy tools." },
    steps: [{ name: "request-tool-1", success: false, attempts: [{}] }],
  });
  assert.equal(failure.code, "LEGACY_RESPONSE_VALIDATION");
  assert.equal(failure.modelUsage, "possibly-incurred");
  assert.equal(failure.diagnostic, undefined);
});

test("unknown platform errors retain safe step context; absent history never implies zero usage", () => {
  for (const steps of [
    undefined,
    [
      {
        name: "private-step-name",
        success: false,
        attempts: [{ error: { message: "private-error-body" } }],
      },
    ],
  ]) {
    const failure = workflowFailure({
      status: "errored",
      error: { message: "private-error-body" },
      steps,
    });
    assert.equal(failure.step, "unknown");
    assert.equal(failure.modelUsage, "unknown");
    assert.doesNotMatch(JSON.stringify(failure), /private-/u);
  }
});

test("poll timeouts record possible usage without replacing an unfinished model instance", async () => {
  const records = [];
  await assert.rejects(
    probe(
      async (_route, options) => {
        assert.notEqual(options?.method, "POST");
        return { status: "running", steps: [{ name: "request-tool-1", attempts: [{}] }] };
      },
      expected,
      { ...fakeClock(3), record: (state) => records.push(state) },
    ),
    /SAME instance/u,
  );
  assert.equal(records.at(-1).failure.code, "WORKFLOW_POLL_TIMEOUT");
  assert.equal(records.at(-1).failure.modelUsage, "possibly-incurred");
  assert.equal(new Set(records.map((record) => record.runId)).size, 1);
});

test("a failed step with opaque output reports its timeout instead of a JSON parse error", async () => {
  const records = [];
  let reads = 0;
  await assert.rejects(
    probe(
      async (_route, options) => {
        reads++;
        assert.notEqual(options?.method, "POST");
        return {
          status: "errored",
          output: "private-invalid-output",
          error: { name: "WorkflowTimeoutError", message: "private-timeout-details" },
          steps: [{ name: "finish-greeting-1", success: false, attempts: [{}] }],
        };
      },
      expected,
      { record: (state) => records.push(state) },
    ),
    (error) => {
      assert.match(error.message, /WORKFLOW_STEP_TIMEOUT/u);
      assert.doesNotMatch(error.message, /private-/u);
      return true;
    },
  );
  assert.equal(reads, 1);
  assert.equal(records.at(-1).failure.modelUsage, "possibly-incurred");
});
