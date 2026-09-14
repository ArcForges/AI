// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApi,
  parseWorkerVersion,
  probe,
  validateLiveOutput,
  waitForWorkerVersion,
} from "../cloudflare.mjs";

const expected = {
  runId: "hello-11111111-1111-4111-8111-111111111111",
  workerVersion: "11111111-1111-4111-8111-111111111111",
  sourceCommit: "a".repeat(40),
  version: "0.1.0-ci.1.1",
};
const completed = () => ({
  status: "complete",
  output: {
    runId: expected.runId,
    workerVersion: expected.workerVersion,
    sourceCommit: expected.sourceCommit,
    buildVersion: expected.version,
    model: "@cf/openai/gpt-oss-20b",
    modelCalls: 2,
    tool: "say_hello",
    toolMessage: "Hello, ArcForges!",
    message: "Hello, ArcForges!",
  },
});

test("a lost create response is never retried within a smoke run", async () => {
  const calls = [];
  const api = async (route, options) => {
    calls.push({ route, options });
    if (calls.length === 1) return null;
    throw new Error("simulated connection loss after submission");
  };
  await assert.rejects(probe(api, expected), /connection loss/u);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options.body, {
    instance_id: expected.runId,
    params: { name: "ArcForges" },
  });
});

test("resuming an existing instance never posts or reruns its model", async () => {
  const calls = [];
  const result = await probe(
    async (route, options) => {
      calls.push({ route, options });
      return completed();
    },
    expected,
    {
      beforeCreate: async () =>
        assert.fail("Existing inference must not repeat readiness or create another instance."),
    },
  );
  assert.equal(result.message, "Hello, ArcForges!");
  assert(calls.every((call) => call.options?.method !== "POST"));
});

function readinessOutput(runId, identity = expected) {
  return {
    status: "complete",
    output: {
      kind: "deployment-probe",
      runId,
      workerVersion: identity.workerVersion,
      sourceCommit: identity.sourceCommit,
      buildVersion: identity.version,
      modelCalls: 0,
    },
  };
}

test("deployment propagation uses model-free probes until all candidate identities match", async () => {
  const posts = [];
  const records = [];
  let clock = 0;
  const stale = [
    null,
    { ...expected, workerVersion: "22222222-2222-4222-8222-222222222222" },
    { ...expected, sourceCommit: "b".repeat(40) },
    { ...expected, version: "0.1.0-local" },
    expected,
  ];
  const result = await waitForWorkerVersion(
    async (route, options) => {
      if (options?.method === "POST") {
        posts.push(options.body);
        return { id: options.body.instance_id };
      }
      if (options?.allowMissing) return null;
      const identity = stale[posts.length - 1];
      return identity ? readinessOutput(route.split("/").at(-1), identity) : { status: "errored" };
    },
    expected,
    {
      pollMs: 1,
      timeoutMs: 20,
      now: () => clock,
      wait: async () => {
        clock++;
      },
      record: (state) => records.push(state),
    },
  );
  assert.equal(posts.length, 5);
  assert.equal(result.workerVersion, expected.workerVersion);
  assert.equal(result.sourceCommit, expected.sourceCommit);
  assert.equal(result.buildVersion, expected.version);
  assert(
    posts.every(
      (body) => JSON.stringify(body.params) === JSON.stringify({ kind: "deployment-probe" }),
    ),
  );
  assert.equal(new Set(posts.map((body) => body.instance_id)).size, posts.length);
  assert.equal(records.filter((record) => record.status === "submitting").length, posts.length);
});

test("a readiness timeout blocks the real inference POST", async () => {
  let clock = 0;
  const api = async (_route, options) => {
    assert.notEqual(options?.method, "POST", "No real inference may start before readiness.");
    return null;
  };
  await assert.rejects(
    probe(api, expected, {
      beforeCreate: () =>
        waitForWorkerVersion(
          async (route) =>
            readinessOutput(route.split("/").at(-1), { ...expected, version: "old" }),
          expected,
          {
            pollMs: 1,
            timeoutMs: 3,
            now: () => clock,
            wait: async () => {
              clock++;
            },
          },
        ),
    }),
    /no live inference was started/u,
  );
  assert.equal(clock, 3);
});

test("a lost readiness create response stops without posting a replacement", async () => {
  const posts = [];
  const runId = `ready-${expected.workerVersion}-1`;
  const api = async (_route, options) => {
    if (options?.method === "POST") {
      posts.push(options.body.instance_id);
      throw new Error("readiness response lost");
    }
    return posts.length ? readinessOutput(runId) : null;
  };
  await assert.rejects(waitForWorkerVersion(api, expected), /response lost/u);
  const resumed = await waitForWorkerVersion(api, expected);
  assert.equal(resumed.runId, runId);
  assert.deepEqual(posts, [runId]);
});

test("failed instances are reported without automatic restart", async () => {
  let calls = 0;
  await assert.rejects(
    probe(async () => {
      calls++;
      return { status: "errored" };
    }, expected),
    /no automatic restart/u,
  );
  assert.equal(calls, 2);
});

test("real evidence must match both the candidate and the deployed Worker version", () => {
  const status = completed();
  assert.equal(
    validateLiveOutput({ ...status, output: JSON.stringify(status.output) }, expected).modelCalls,
    2,
  );
  status.output.workerVersion = "22222222-2222-4222-8222-222222222222";
  assert.throws(() => validateLiveOutput(status, expected), /another Worker version/u);
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
