// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApi, parseWorkerVersion, probe, validateLiveOutput } from "../cloudflare.mjs";

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
  const result = await probe(async (route, options) => {
    calls.push({ route, options });
    return completed();
  }, expected);
  assert.equal(result.message, "Hello, ArcForges!");
  assert(calls.every((call) => call.options?.method !== "POST"));
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
