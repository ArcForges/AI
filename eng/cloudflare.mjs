// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expectedIdentity, runtimeIdentity } from "./build-identity.mjs";
import { readModelFailure } from "../src/model-diagnostics.ts";
import {
  CANDIDATE,
  ROOT,
  readJson,
  sha256,
  verifyCandidate,
  wrangler,
  writeJson,
} from "./project.mjs";

const WORKFLOW = "arcforges-ai-hello";
const EVIDENCE = path.join(ROOT, "artifacts/deployment");
const DEPLOYMENT = path.join(EVIDENCE, "deployment.json");
const SMOKE_PROTOCOL = "verified-hello-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function credentials() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  assert(
    /^[0-9a-f]{32}$/iu.test(accountId ?? ""),
    "Set CLOUDFLARE_ACCOUNT_ID to the target account's 32-character ID.",
  );
  let token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    assert(
      !process.env.CI,
      "CI requires the cloudflare environment's CLOUDFLARE_API_TOKEN secret.",
    );
    // Capture credentials privately. Never pass this command to the general
    // runner, which includes command output in errors, or print its JSON.
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "auth", "token", "--json"],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      },
    );
    assert.equal(
      result.status,
      0,
      "Cloudflare authentication is missing. Run npm exec -- wrangler login, then retry.",
    );
    let auth;
    try {
      auth = JSON.parse(result.stdout);
    } catch {
      throw new Error("Could not read Wrangler credentials. Run npm exec -- wrangler login.");
    }
    assert(
      ["oauth", "api_token"].includes(auth.type),
      "Use a scoped API token or Wrangler OAuth, not a Global API Key.",
    );
    token = auth.token;
  }
  assert(typeof token === "string" && token.length > 0, "Cloudflare API token is missing.");
  return { accountId, token };
}

export function createApi({ accountId, token }, fetcher = fetch) {
  return async (suffix, { method = "GET", body, allowMissing = false } = {}) => {
    assert(/^\/[a-zA-Z0-9_/?=&.-]*$/u.test(suffix), "Unexpected Cloudflare API path.");
    let response;
    try {
      response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}${suffix}`,
        {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    } catch {
      throw new Error(
        `Cloudflare ${method} did not return a response. Inspect the recorded run ID before any new execution.`,
      );
    }
    if (allowMissing && response.status === 404) return null;
    // Do not echo arbitrary remote response bodies or headers into CI logs.
    assert(
      response.ok,
      `Cloudflare ${method} returned HTTP ${response.status}. Check permissions and the account dashboard.`,
    );
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error("Cloudflare returned invalid JSON.");
    }
    assert.equal(
      envelope.success,
      true,
      "Cloudflare did not confirm success. Check the account dashboard.",
    );
    return envelope.result;
  };
}

export function parseWorkerVersion(log) {
  const matches = [...log.matchAll(/Current Version ID:\s*([0-9a-f-]{36})/giu)];
  assert.equal(
    matches.length,
    1,
    "Deployment finished without one recognized version ID; inspect Cloudflare before retrying.",
  );
  assert(UUID.test(matches[0][1]));
  return matches[0][1];
}

export function validateLiveOutput(result, expected) {
  let output = result.output;
  if (typeof output === "string") output = JSON.parse(output);
  assert(output && typeof output === "object", "Workflow output is missing.");
  assert.equal(result.status, "complete");
  assert.equal(output.runId, expected.runId);
  assert.equal(
    output.workerVersion,
    expected.workerVersion,
    "Workflow used another Worker version.",
  );
  assert.equal(output.sourceCommit, expected.sourceCommit);
  assert.equal(output.buildVersion, expected.version);
  assert.equal(output.admission?.accepted, true, "Workflow did not record deployment admission.");
  assert.deepEqual(output.admission.expected, verifiedHelloParams(expected).expected);
  assert.deepEqual(output.admission.actual, {
    runId: expected.runId,
    ...verifiedHelloParams(expected).expected,
  });
  assert.equal(output.model, "@cf/openai/gpt-oss-20b");
  assert.equal(output.modelCalls, 2);
  assert.equal(output.tool, "say_hello");
  assert.equal(output.toolMessage, "Hello, ArcForges!");
  assert.deepEqual(
    output.buildIdentity,
    expected.buildIdentity,
    "Workflow compiled candidate identity differs.",
  );
  assert(
    typeof output.message === "string" && output.message.trim() && output.message.length <= 4096,
    "Model did not return a bounded greeting.",
  );
  return output;
}

export function verifiedHelloParams(expected) {
  return {
    kind: "verified-hello",
    expected: {
      workerVersion: expected.workerVersion,
      sourceCommit: expected.sourceCommit,
      buildVersion: expected.version,
    },
    hello: { name: "ArcForges" },
  };
}

function jsonValue(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function rejectedBeforeModel(status, expected) {
  const params = verifiedHelloParams(expected);
  // Never advance on an arbitrary error, missing step history, or an output
  // claiming zero calls after a model step may already have been dispatched.
  if (
    status.status === "errored" &&
    status.error?.message ===
      "NonRetryableError: Invalid Hello Agent input; no model call was admitted." &&
    status.step_count === 0 &&
    Array.isArray(status.steps) &&
    status.steps.length === 0
  ) {
    assert.deepEqual(jsonValue(status.params), params, "Unexpected rejected instance input.");
    return { reason: "older-runtime-rejected-guarded-input", modelCalls: 0 };
  }
  // Failed/pending instances may have empty or opaque output. Their error and
  // step history must remain observable without trying to parse a final result.
  if (status.status !== "complete") return null;
  const output = jsonValue(status.output);
  if (output?.kind !== "deployment-rejected") return null;
  assert.deepEqual(jsonValue(status.params), params, "Unexpected rejected instance input.");
  assert.equal(output.runId, expected.runId);
  assert.deepEqual(output.expected, params.expected);
  assert.equal(output.modelCalls, 0);
  assert.equal(status.step_count, 1, "Rejection has unexpected step history; stop for inspection.");
  assert.equal(status.steps?.length, 1);
  assert.equal(status.steps[0].name, "admit-deployment-1");
  assert.equal(status.steps[0].success, true);
  const actual = {
    workerVersion: output.workerVersion,
    sourceCommit: output.sourceCommit,
    buildVersion: output.buildVersion,
  };
  assert(UUID.test(actual.workerVersion));
  assert(typeof actual.sourceCommit === "string" && typeof actual.buildVersion === "string");
  assert.notDeepEqual(
    actual,
    params.expected,
    "Matching identity unexpectedly rejected admission.",
  );
  return { reason: "deployment-identity-rejected", modelCalls: 0, actual };
}

export function workflowFailure(status, code = "WORKFLOW_FAILED") {
  const steps = Array.isArray(status.steps) ? status.steps : [];
  const failed = steps.findLast((step) => step?.success === false) ?? steps.at(-1);
  const attempts = Array.isArray(failed?.attempts) ? failed.attempts : [];
  const error = attempts.findLast((attempt) => attempt?.error)?.error ?? status.error;
  const diagnostic = readModelFailure(error?.message) ?? readModelFailure(status.error?.message);
  const step = [
    "admit-deployment-1",
    "request-tool-1",
    "say-hello-1",
    "finish-greeting-1",
  ].includes(failed?.name)
    ? failed.name
    : "unknown";
  const modelStepsObserved = steps.filter((item) =>
    ["request-tool-1", "finish-greeting-1"].includes(item?.name),
  ).length;
  const legacyResponseError =
    error?.message === "Expected a completed assistant message without refusal or legacy tools.";
  return {
    code:
      diagnostic?.code ??
      (legacyResponseError
        ? "LEGACY_RESPONSE_VALIDATION"
        : error?.name === "WorkflowTimeoutError"
          ? "WORKFLOW_STEP_TIMEOUT"
          : code),
    step,
    attempts: Array.isArray(failed?.attempts) ? attempts.length : null,
    modelStepsObserved,
    // Missing history is not evidence of zero calls, and a timeout cannot
    // establish whether a dispatched provider request stopped or was billed.
    modelUsage: modelStepsObserved > 0 || diagnostic ? "possibly-incurred" : "unknown",
    ...(diagnostic ? { diagnostic } : {}),
  };
}

// Every candidate instance checks its OWN identity before AI. Only a proven
// model-free rejection permits another ID. Pending/unknown/model failures stop.
export async function probe(
  api,
  expected,
  { pollMs = 6000, timeoutMs = 300_000, record = () => {}, wait = delay, now = Date.now } = {},
) {
  assert.equal(
    expected.smokeProtocol,
    SMOKE_PROTOCOL,
    "Legacy smoke record: inspect its existing instance; deploy a guarded candidate before a new smoke.",
  );
  const base = `/workflows/${WORKFLOW}/instances`;
  const deadline = now() + timeoutMs;
  for (let attempt = 1; attempt <= 30 && now() < deadline; attempt++) {
    const runId = attempt === 1 ? expected.runId : `${expected.runId}-${attempt}`;
    const target = { ...expected, runId };
    const route = `${base}/${runId}`;
    let status = await api(route, { allowMissing: true });
    if (status === null) {
      record({ runId, status: "submitting" });
      // Match the pinned Wrangler implementation: params is an object, not
      // double-encoded JSON. Older runtimes reject this shape before any AI.
      const created = await api(base, {
        method: "POST",
        body: { instance_id: runId, params: verifiedHelloParams(expected) },
      });
      assert.equal(created.id, runId, "Cloudflare returned an unexpected instance ID.");
      status = await api(route);
    }
    while (true) {
      const observed = {
        runId,
        status: status.status,
        workflowVersion: status.versionId,
        stepCount: status.step_count,
        checkedAt: new Date().toISOString(),
      };
      record(observed);
      const rejected = rejectedBeforeModel(status, target);
      if (rejected) {
        record({ ...observed, ...rejected });
        break;
      }
      if (status.status === "complete") return validateLiveOutput(status, target);
      if (!["queued", "running", "waiting"].includes(status.status)) {
        const failure = workflowFailure(status);
        record({ ...observed, failure });
        throw new Error(
          `Workflow ${runId} failed: ${JSON.stringify(failure)}. No automatic restart was attempted. Inspect this instance before a new paid attempt.`,
        );
      }
      if (now() >= deadline) {
        const failure = workflowFailure(status, "WORKFLOW_POLL_TIMEOUT");
        record({ ...observed, failure });
        throw new Error(
          `Workflow ${runId} has not completed: ${JSON.stringify(failure)}. Preserve its evidence and rerun test:live to query the SAME instance.`,
        );
      }
      await wait(pollMs);
      status = await api(route);
    }
    if (now() < deadline) await wait(pollMs);
  }
  throw new Error(
    "Deployment admission limit reached; all observed attempts were rejected before AI. Inspect the recorded instances before continuing.",
  );
}

async function deploy() {
  const manifest = verifyCandidate();
  assert.equal(
    manifest.sourceDirty,
    false,
    "Commit source changes and rebuild before deploying a candidate.",
  );
  const auth = credentials();
  const candidateSha256 = sha256(fs.readFileSync(path.join(CANDIDATE, "candidate.json")));
  // Keep a record even if upload succeeds but CLI confirmation is lost.
  writeJson(path.join(EVIDENCE, "intent.json"), {
    accountId: auth.accountId,
    sourceCommit: manifest.sourceCommit,
    version: manifest.version,
    candidateSha256,
    requestedAt: new Date().toISOString(),
  });
  let output;
  try {
    output = wrangler(
      [
        "deploy",
        "--config",
        path.join(CANDIDATE, "wrangler.json"),
        "--no-bundle",
        "--tag",
        manifest.version,
        "--message",
        manifest.sourceCommit,
      ],
      {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: auth.accountId,
          CLOUDFLARE_API_TOKEN: auth.token,
          NO_COLOR: "1",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
  } catch (error) {
    // Wrangler normally redacts credentials; also redact our exact token.
    throw new Error(String(error).replaceAll(auth.token, "[REDACTED]"));
  }
  const workerVersion = parseWorkerVersion(output);
  console.log(output.replaceAll(auth.token, "[REDACTED]"));
  verifyCandidate();
  const runId = `hello-${workerVersion}`;
  writeJson(DEPLOYMENT, {
    accountId: auth.accountId,
    workflow: WORKFLOW,
    smokeProtocol: SMOKE_PROTOCOL,
    workerVersion,
    runId,
    sourceCommit: manifest.sourceCommit,
    version: manifest.version,
    candidateSha256,
    buildIdentity: runtimeIdentity(expectedIdentity(manifest.version)),
    deployedAt: new Date().toISOString(),
  });
  console.log(`Deployed the verified bundle. Next: npm run test:live (instance ${runId}).`);
}

async function smoke() {
  const manifest = verifyCandidate();
  assert(
    fs.existsSync(DEPLOYMENT),
    "No deployment record. Deploy the verified candidate first, or restore that deployment's evidence.",
  );
  const expected = readJson(DEPLOYMENT);
  const auth = credentials();
  assert.equal(expected.accountId, auth.accountId);
  assert.equal(expected.sourceCommit, manifest.sourceCommit);
  assert.equal(expected.version, manifest.version);
  assert.deepEqual(expected.buildIdentity, runtimeIdentity(expectedIdentity(manifest.version)));
  assert.equal(
    expected.candidateSha256,
    sha256(fs.readFileSync(path.join(CANDIDATE, "candidate.json"))),
  );
  assert(UUID.test(expected.workerVersion) && expected.runId === `hello-${expected.workerVersion}`);
  const api = createApi(auth);
  console.log("Each live instance must admit the deployed identity before either model call.");
  const output = await probe(api, expected, {
    record: (state) => {
      writeJson(path.join(EVIDENCE, "admission", `${state.runId}.json`), state);
      writeJson(path.join(EVIDENCE, "live-state.json"), state);
      if (state.reason) console.log(`${state.runId}: ${state.reason}; zero model calls.`);
    },
  });
  writeJson(path.join(EVIDENCE, "live-evidence.json"), {
    kind: "cloudflare-real-inference",
    verifiedAt: new Date().toISOString(),
    ...expected,
    runId: output.runId,
    output,
  });
  console.log(`Real Workflow/model/tool/model passed for ${output.runId}: ${output.message}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "deploy") await deploy();
    else if (process.argv[2] === "smoke") await smoke();
    else throw new Error("Expected deploy or smoke.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cloudflare operation failed.");
    process.exitCode = 1;
  }
}
