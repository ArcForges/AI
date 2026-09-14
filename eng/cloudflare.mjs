// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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
  assert.equal(output.model, "@cf/openai/gpt-oss-20b");
  assert.equal(output.modelCalls, 2);
  assert.equal(output.tool, "say_hello");
  assert.equal(output.toolMessage, "Hello, ArcForges!");
  assert(
    typeof output.message === "string" && output.message.trim() && output.message.length <= 4096,
    "Model did not return a bounded greeting.",
  );
  return output;
}

// A completed probe is immutable, so a stale result needs a new probe ID.
// Only these model-free probes may repeat; the real inference instance may not.
export async function waitForWorkerVersion(
  api,
  expected,
  { pollMs = 10_000, timeoutMs = 300_000, record = () => {}, wait = delay, now = Date.now } = {},
) {
  const base = `/workflows/${WORKFLOW}/instances`;
  const deadline = now() + timeoutMs;
  for (let attempt = 1; attempt <= 30 && now() < deadline; attempt++) {
    const runId = `ready-${expected.workerVersion}-${attempt}`;
    const route = `${base}/${runId}`;
    let status = await api(route, { allowMissing: true });
    if (status === null) {
      record({ runId, status: "submitting" });
      const created = await api(base, {
        method: "POST",
        body: { instance_id: runId, params: { kind: "deployment-probe" } },
      });
      assert.equal(created.id, runId, "Cloudflare returned an unexpected readiness instance ID.");
      status = await api(route);
    }
    while (["queued", "running", "waiting"].includes(status.status) && now() < deadline) {
      record({ runId, status: status.status });
      await wait(pollMs);
      status = await api(route);
    }
    if (status.status === "complete") {
      const output = typeof status.output === "string" ? JSON.parse(status.output) : status.output;
      assert.equal(output?.kind, "deployment-probe", "Unexpected readiness output.");
      assert.equal(output.runId, runId);
      assert.equal(output.modelCalls, 0, "Readiness must not call a model.");
      const observed = {
        runId,
        status: "complete",
        workflowVersion: status.versionId,
        workerVersion: output.workerVersion,
        sourceCommit: output.sourceCommit,
        buildVersion: output.buildVersion,
        modelCalls: output.modelCalls,
      };
      record(observed);
      if (
        now() < deadline &&
        output.workerVersion === expected.workerVersion &&
        output.sourceCommit === expected.sourceCommit &&
        output.buildVersion === expected.version
      ) {
        return observed;
      }
    } else {
      // Bootstrap versions reject this non-Hello payload before any AI call.
      // A timeout or an error here never restarts a real inference instance.
      record({ runId, status: status.status });
      assert(
        ["errored", "terminated", "queued", "running", "waiting"].includes(status.status),
        `Readiness Workflow is ${status.status}; inspect it before continuing.`,
      );
    }
    if (now() < deadline) await wait(pollMs);
  }
  throw new Error(
    "Workflow has not observed the deployed candidate within the readiness limit; no live inference was started.",
  );
}

// A stable ID permits read-only resumption after a lost POST response. Do not
// restart failed instances or create a replacement ID inside this function.
export async function probe(
  api,
  expected,
  {
    pollMs = 6000,
    timeoutMs = 300_000,
    record = () => {},
    wait = delay,
    beforeCreate = async () => {},
  } = {},
) {
  const base = `/workflows/${WORKFLOW}/instances`;
  const instance = `${base}/${expected.runId}`;
  let status = await api(instance, { allowMissing: true });
  if (status === null) {
    await beforeCreate();
    record({ status: "submitting", ...expected });
    // Match the pinned Wrangler implementation: params is the object itself.
    // The REST reference currently labels it a JSON string; encoding it twice
    // would deliver a string to WorkflowEvent.payload instead of HelloParams.
    const created = await api(base, {
      method: "POST",
      body: { instance_id: expected.runId, params: { name: "ArcForges" } },
    });
    assert.equal(created.id, expected.runId, "Cloudflare returned an unexpected instance ID.");
  }
  const deadline = Date.now() + timeoutMs;
  do {
    status = await api(instance);
    record({ ...expected, status: status.status, checkedAt: new Date().toISOString() });
    if (status.status === "complete") return validateLiveOutput(status, expected);
    assert(
      ["queued", "running", "waiting"].includes(status.status),
      `Workflow is ${status.status}; no automatic restart was attempted.`,
    );
    await wait(pollMs);
  } while (Date.now() < deadline);
  throw new Error(
    `Workflow ${expected.runId} has not completed. Run npm run test:live again to query the SAME instance.`,
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
    workerVersion,
    runId,
    sourceCommit: manifest.sourceCommit,
    version: manifest.version,
    candidateSha256,
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
  assert.equal(
    expected.candidateSha256,
    sha256(fs.readFileSync(path.join(CANDIDATE, "candidate.json"))),
  );
  assert(UUID.test(expected.workerVersion) && expected.runId === `hello-${expected.workerVersion}`);
  const api = createApi(auth);
  const output = await probe(api, expected, {
    beforeCreate: async () => {
      console.log("Waiting for the deployed Workflow identity without calling a model.");
      const ready = await waitForWorkerVersion(api, expected, {
        record: (state) =>
          writeJson(path.join(EVIDENCE, "readiness", `${state.runId}.json`), state),
      });
      writeJson(path.join(EVIDENCE, "readiness-evidence.json"), {
        ...ready,
        checkedAt: new Date().toISOString(),
      });
      console.log(
        "Workflow identity matches the candidate. Starting the single live inference instance.",
      );
    },
    record: (state) => writeJson(path.join(EVIDENCE, "live-state.json"), state),
  });
  writeJson(path.join(EVIDENCE, "live-evidence.json"), {
    kind: "cloudflare-real-inference",
    verifiedAt: new Date().toISOString(),
    ...expected,
    output,
  });
  console.log(`Real Workflow/model/tool/model passed for ${expected.runId}: ${output.message}`);
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
