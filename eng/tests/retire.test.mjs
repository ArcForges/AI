// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { createApi, deploy } from "../cloudflare.mjs";
import { ROOT, readJson } from "../project.mjs";
import {
  CONFIRMATION,
  DRAIN_MS,
  HISTORY_PAGES,
  NON_TERMINAL,
  PAGE_SIZE,
  RetirementRefused,
  TERMINAL,
  VERIFY_ATTEMPTS,
  WORKER,
  WORKFLOW,
  allowed,
  checkConfig,
  guard,
  instancesPath,
  planRetirement,
  retire,
} from "../retire.mjs";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "retire-test-token-value";
const BODY_MARKER = "remote-body-marker";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const OLD = new Date(NOW - DRAIN_MS - 86_400_000).toISOString();
const config = readJson(path.join(ROOT, "wrangler.json"));
const SETTINGS = `/workers/scripts/${WORKER}/settings`;
const SCRIPT = `/workers/scripts/${WORKER}`;
const DEFINITION = `/workflows/${WORKFLOW}`;

const workflowBody = (overrides = {}) => ({
  id: "wf-1",
  name: WORKFLOW,
  script_name: WORKER,
  class_name: "HelloAgentWorkflow",
  created_on: OLD,
  modified_on: OLD,
  triggered_on: OLD,
  instances: Object.fromEntries([...NON_TERMINAL, ...TERMINAL].map((status) => [status, 0])),
  ...overrides,
});
const instance = (id, status, at = OLD) => ({
  id,
  status,
  created_on: at,
  modified_on: at,
  started_on: at,
  ended_on: TERMINAL.includes(status) ? at : null,
  version_id: "v-1",
  workflow_id: "wf-1",
});

// A fake Cloudflare account: only the fetch boundary is substituted, so the
// real createApi envelope, status and redaction handling are exercised.
function account({ worker = true, workflow = workflowBody(), lists = {}, responses = {} } = {}) {
  const calls = [];
  const state = { worker, workflow };
  const ok = (result) => ({ status: 200, body: { success: true, errors: [], result } });
  const fetcher = async (url, init) => {
    assert(url.startsWith(BASE), "Request left the configured account.");
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(init.redirect, "error");
    const suffix = url.slice(BASE.length);
    const key = `${init.method} ${suffix}`;
    calls.push(key);
    let reply = responses[key]?.(state);
    if (!reply) {
      if (key === `GET ${SETTINGS}`)
        reply = state.worker ? ok({ bindings: [], tags: [] }) : { status: 404 };
      else if (key === `GET ${DEFINITION}`)
        reply = state.workflow ? ok(state.workflow) : { status: 404 };
      else if (init.method === "GET" && suffix.startsWith(`${DEFINITION}/instances?`)) {
        const query = new URLSearchParams(suffix.slice(suffix.indexOf("?") + 1));
        const pages = lists[query.get("status")] ?? [];
        reply = ok(pages[Number(query.get("page")) - 1] ?? []);
      } else if (key === `DELETE ${DEFINITION}`) {
        state.workflow = null;
        reply = ok({ status: "ok" });
      } else if (key === `DELETE ${SCRIPT}`) {
        state.worker = false;
        reply = ok({ id: WORKER });
      } else reply = { status: 500, body: { success: false, errors: [{ message: BODY_MARKER }] } };
    }
    return new Response(JSON.stringify(reply.body ?? { success: false, marker: BODY_MARKER }), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, state, api: createApi({ accountId: ACCOUNT, token: TOKEN }, fetcher) };
}

function run(cloud, options = {}) {
  const writes = {};
  const logs = [];
  const promise = retire({
    mode: "dry-run",
    confirm: "",
    api: cloud.api,
    config,
    now: () => NOW,
    wait: async () => {},
    write: (name, value) => {
      writes[name] = JSON.parse(JSON.stringify(value));
    },
    log: (line) => logs.push(line),
    ...options,
  });
  return { promise, writes, logs };
}

const planGets = () => [
  `GET ${SETTINGS}`,
  `GET ${DEFINITION}`,
  ...NON_TERMINAL.map((status) => `GET ${instancesPath(status, 1)}`),
  ...TERMINAL.map((status) => `GET ${instancesPath(status, 1)}`),
];

test("the retired targets are the constants declared by wrangler.json", () => {
  assert.equal(WORKER, "arcforges-ai-hello");
  assert.equal(WORKFLOW, "arcforges-ai-hello");
  assert.equal(CONFIRMATION, "delete arcforges-ai-hello");
  checkConfig(config);
  assert.throws(() => checkConfig({ ...config, name: "other" }), /retired Worker/u);
  assert.throws(() => checkConfig({ ...config, workflows: [] }), /exactly/u);
  assert.throws(
    () => checkConfig({ ...config, workflows: [{ ...config.workflows[0], name: "other" }] }),
    /another Workflow/u,
  );
  assert.throws(
    () => checkConfig({ ...config, workflows: [{ ...config.workflows[0], script_name: "other" }] }),
    /own Worker/u,
  );
});

test("dry-run plans with GET requests only and writes plan.json", async () => {
  const cloud = account();
  const { promise, writes, logs } = run(cloud);
  const { plan } = await promise;
  assert.deepEqual(cloud.calls, planGets());
  assert(cloud.calls.every((call) => call.startsWith("GET ")));
  assert.equal(plan.decision, "eligible");
  assert.deepEqual(plan.reasons, []);
  assert.deepEqual(Object.keys(writes), ["plan.json"]);
  assert.equal(writes["plan.json"].workflow.scriptName, WORKER);
  assert.equal(writes["plan.json"].latestActivity, OLD);
  assert.equal(writes["plan.json"].checkedAt, new Date(NOW).toISOString());
  assert(logs.at(-1).includes("no request other than GET"));
});

test("dry-run refuses every non-GET request before it reaches the network", async () => {
  const cloud = account();
  const guarded = guard(cloud.api, "dry-run");
  await assert.rejects(guarded(DEFINITION, { method: "DELETE" }), /only GET/u);
  await assert.rejects(guarded(SCRIPT, { method: "DELETE" }), /only GET/u);
  assert.deepEqual(cloud.calls, []);
});

test("invalid mode or a missing or inexact confirmation sends no request", async () => {
  for (const [mode, confirm] of [
    ["delete", ""],
    ["delete", "delete arcforges-ai-hello "],
    ["delete", "DELETE arcforges-ai-hello"],
    ["delete", undefined],
    ["purge", CONFIRMATION],
    ["", ""],
  ]) {
    const cloud = account();
    const { promise, writes } = run(cloud, { mode, confirm });
    await assert.rejects(promise, RetirementRefused);
    assert.deepEqual(cloud.calls, [], `${mode}/${confirm}`);
    assert.deepEqual(writes, {});
  }
});

test("each listed non-terminal instance refuses the plan and blocks deletion", async () => {
  for (const status of NON_TERMINAL) {
    const cloud = account({ lists: { [status]: [[instance("i-1", status)]] } });
    const { promise, writes } = run(cloud, { mode: "delete", confirm: CONFIRMATION });
    await assert.rejects(promise, /Retirement refused/u);
    assert(writes["plan.json"].reasons.some((reason) => reason.includes(`${status} instance`)));
    assert.equal(writes["result.json"].outcome, "refused");
    assert(
      cloud.calls.every((call) => call.startsWith("GET ")),
      status,
    );
  }
});

test("each non-terminal instance count refuses the plan", async () => {
  for (const status of NON_TERMINAL) {
    const cloud = account({
      workflow: workflowBody({ instances: { ...workflowBody().instances, [status]: 2 } }),
    });
    const { promise, writes } = run(cloud);
    await assert.rejects(promise, RetirementRefused);
    assert(writes["plan.json"].reasons.includes(`2 ${status} instance(s) are not terminal.`));
  }
});

test("a full non-terminal page refuses without reading further pages", async () => {
  const rows = Array.from({ length: PAGE_SIZE }, (_, index) => instance(`q-${index}`, "queued"));
  const cloud = account({ lists: { queued: [rows, [instance("q-x", "queued")]] } });
  const { promise, writes } = run(cloud);
  await assert.rejects(promise, RetirementRefused);
  assert(writes["plan.json"].reasons.includes(`100 or more queued instance(s) are listed.`));
  assert(!cloud.calls.includes(`GET ${instancesPath("queued", 2)}`));
});

test("unknown instance statuses refuse the plan", async () => {
  const counted = account({
    workflow: workflowBody({ instances: { ...workflowBody().instances, unknown: 1 } }),
  });
  const first = run(counted);
  await assert.rejects(first.promise, RetirementRefused);
  assert(first.writes["plan.json"].reasons.some((reason) => reason.includes("status unknown")));

  const listed = account({ lists: { complete: [[instance("c-1", "unknown")]] } });
  const second = run(listed);
  await assert.rejects(second.promise, RetirementRefused);
  assert(second.writes["plan.json"].reasons.some((reason) => reason.includes("status unknown")));

  const hostile = account({
    workflow: workflowBody({ instances: { ...workflowBody().instances, "<b>x</b>": 1 } }),
  });
  const third = run(hostile);
  await assert.rejects(third.promise, RetirementRefused);
  assert(!JSON.stringify(third.writes).includes("<b>"));
});

test("the seven-day drain horizon refuses inside and admits at the boundary", async () => {
  for (const [offset, decision] of [
    [DRAIN_MS - 1, "refused"],
    [DRAIN_MS, "eligible"],
    [DRAIN_MS + 1, "eligible"],
    [-60_000, "refused"],
  ]) {
    const at = new Date(NOW - offset).toISOString();
    for (const cloud of [
      account({ workflow: workflowBody({ triggered_on: at }) }),
      account({ lists: { complete: [[instance("c-1", "complete", at)]] } }),
    ]) {
      const { promise, writes } = run(cloud);
      if (decision === "refused") await assert.rejects(promise, RetirementRefused);
      else await promise;
      assert.equal(writes["plan.json"].decision, decision, `${offset}`);
      assert.equal(writes["plan.json"].latestActivity, at);
    }
  }
});

test("terminal history is paged and an unbounded history refuses", async () => {
  const page = (prefix) =>
    Array.from({ length: PAGE_SIZE }, (_, index) => instance(`${prefix}-${index}`, "complete"));
  const paged = account({ lists: { complete: [page("a"), [instance("b-0", "complete")]] } });
  const { promise, writes } = run(paged);
  await promise;
  assert.equal(writes["plan.json"].terminalListed.complete, PAGE_SIZE + 1);
  assert(paged.calls.includes(`GET ${instancesPath("complete", 2)}`));
  assert(!paged.calls.includes(`GET ${instancesPath("complete", 3)}`));

  const full = Array.from({ length: HISTORY_PAGES }, (_, index) => page(`p${index}`));
  const unbounded = account({ lists: { complete: full } });
  const second = run(unbounded);
  await assert.rejects(second.promise, RetirementRefused);
  assert(second.writes["plan.json"].reasons.some((reason) => reason.includes("full pages")));
  assert.equal(
    unbounded.calls.filter((call) => call.includes("status=complete")).length,
    HISTORY_PAGES,
  );

  const repeated = account({ lists: { complete: [page("r"), page("r")] } });
  const third = run(repeated);
  await assert.rejects(third.promise, RetirementRefused);
  assert(third.writes["plan.json"].reasons.some((reason) => reason.includes("paging")));
});

test("a Workflow served by another Worker or with malformed timing refuses", async () => {
  for (const workflow of [
    workflowBody({ script_name: "other-worker" }),
    workflowBody({ triggered_on: "yesterday-ish" }),
    (() => {
      const body = workflowBody();
      delete body.triggered_on;
      return body;
    })(),
    workflowBody({ instances: undefined }),
    workflowBody({ instances: { ...workflowBody().instances, complete: -1 } }),
  ]) {
    const cloud = account({ workflow });
    const { promise, writes } = run(cloud);
    await assert.rejects(promise, RetirementRefused);
    assert.equal(writes["plan.json"].decision, "refused");
  }
  const never = account({ workflow: workflowBody({ triggered_on: null }) });
  const { promise, writes } = run(never);
  await promise;
  assert.equal(writes["plan.json"].workflow.triggeredOn, null);
});

test("delete re-plans, deletes the Workflow then the Worker without force, and proves 404", async () => {
  const cloud = account();
  const { promise, writes, logs } = run(cloud, { mode: "delete", confirm: CONFIRMATION });
  const { result } = await promise;
  assert.deepEqual(cloud.calls, [
    ...planGets(),
    `DELETE ${DEFINITION}`,
    `DELETE ${SCRIPT}`,
    `GET ${DEFINITION}`,
    `GET ${SETTINGS}`,
  ]);
  assert(!cloud.calls.some((call) => call.includes("force")));
  assert.equal(result.outcome, "deleted");
  assert.deepEqual(Object.keys(writes).sort(), ["plan.json", "result.json"]);
  assert.deepEqual(
    writes["result.json"].steps.map((step) => [step.action, step.outcome]),
    [
      ["delete-workflow", "deleted"],
      ["delete-worker", "deleted"],
      ["verify-absent", "not-found"],
    ],
  );
  assert(logs.at(-1).includes("return 404"));
});

test("a 403 on the Workflow DELETE stops before the Worker DELETE", async () => {
  const cloud = account({
    responses: {
      [`DELETE ${DEFINITION}`]: () => ({ status: 403, body: { success: false, m: BODY_MARKER } }),
    },
  });
  const { promise, writes } = run(cloud, { mode: "delete", confirm: CONFIRMATION });
  await assert.rejects(promise, /HTTP 403/u);
  assert.equal(cloud.calls.at(-1), `DELETE ${DEFINITION}`);
  assert(!cloud.calls.includes(`DELETE ${SCRIPT}`));
  assert.equal(writes["result.json"].outcome, "failed");
  assert.match(writes["result.json"].error, /HTTP 403/u);
});

test("a non-2xx plan read stops before any DELETE", async () => {
  const cloud = account({
    responses: { [`GET ${instancesPath("paused", 1)}`]: () => ({ status: 500 }) },
  });
  const { promise } = run(cloud, { mode: "delete", confirm: CONFIRMATION });
  await assert.rejects(promise, /HTTP 500/u);
  assert(cloud.calls.every((call) => call.startsWith("GET ")));
});

test("deletion fails when Cloudflare keeps reporting a deleted target", async () => {
  const cloud = account({
    responses: { [`DELETE ${SCRIPT}`]: () => ({ status: 200, body: { success: true } }) },
  });
  const waits = [];
  const { promise, writes } = run(cloud, {
    mode: "delete",
    confirm: CONFIRMATION,
    wait: async (ms) => waits.push(ms),
  });
  await assert.rejects(promise, /still reports/u);
  assert.equal(waits.length, VERIFY_ATTEMPTS - 1);
  assert.equal(writes["result.json"].outcome, "failed");

  let reads = 0;
  const lagging = account({
    responses: {
      [`GET ${SETTINGS}`]: (state) =>
        state.worker || reads++ < 1
          ? { status: 200, body: { success: true, result: {} } }
          : { status: 404 },
    },
  });
  const second = run(lagging, { mode: "delete", confirm: CONFIRMATION });
  const { result } = await second.promise;
  assert.equal(result.steps.at(-1).attempts, 2);
});

test("an already retired deployment sends no DELETE and still proves 404", async () => {
  const cloud = account({ worker: false, workflow: null });
  const { promise } = run(cloud, { mode: "delete", confirm: CONFIRMATION });
  const { plan, result } = await promise;
  assert.equal(plan.decision, "already-retired");
  assert.equal(result.outcome, "already-retired");
  assert.deepEqual(cloud.calls, [
    `GET ${SETTINGS}`,
    `GET ${DEFINITION}`,
    `GET ${DEFINITION}`,
    `GET ${SETTINGS}`,
  ]);

  const partial = account({ workflow: null });
  const second = run(partial, { mode: "delete", confirm: CONFIRMATION });
  await second.promise;
  assert(!partial.calls.includes(`DELETE ${DEFINITION}`));
  assert(partial.calls.includes(`DELETE ${SCRIPT}`));
});

test("only the retirement endpoints are reachable", async () => {
  const gets = [
    SETTINGS,
    DEFINITION,
    ...NON_TERMINAL.map((status) => instancesPath(status, 1)),
    ...TERMINAL.flatMap((status) =>
      Array.from({ length: HISTORY_PAGES }, (_, index) => instancesPath(status, index + 1)),
    ),
  ];
  for (const suffix of gets) assert(allowed("GET", suffix), suffix);
  assert(allowed("DELETE", DEFINITION));
  assert(allowed("DELETE", SCRIPT));
  for (const [method, suffix] of [
    ["GET", "/workers/scripts"],
    ["GET", "/workers/scripts/other/settings"],
    ["GET", "/workflows"],
    ["GET", `${DEFINITION}/instances`],
    ["GET", instancesPath("queued", 2)],
    ["GET", instancesPath("complete", HISTORY_PAGES + 1)],
    ["GET", instancesPath("unknown", 1)],
    ["DELETE", `${SCRIPT}?force=true`],
    ["DELETE", SETTINGS],
    ["DELETE", "/workers/scripts/other"],
    ["DELETE", "/workflows/other"],
    ["POST", `${DEFINITION}/instances`],
    ["PUT", SCRIPT],
    ["PATCH", DEFINITION],
    ["constructor", SCRIPT],
  ])
    assert(!allowed(method, suffix), `${method} ${suffix}`);
  const cloud = account();
  const guarded = guard(cloud.api, "delete");
  await assert.rejects(guarded(`${SCRIPT}?force=true`, { method: "DELETE" }), /allowlist/u);
  await assert.rejects(guarded("/workers/scripts/other", { method: "DELETE" }), /allowlist/u);
  assert.deepEqual(cloud.calls, []);
});

test("no credential or remote response body reaches logs, records or errors", async () => {
  const outputs = [];
  for (const cloud of [
    account(),
    account({ lists: { running: [[instance("r-1", "running")]] } }),
    account({
      responses: {
        [`DELETE ${DEFINITION}`]: () => ({ status: 403, body: { success: false, m: BODY_MARKER } }),
      },
    }),
    account({
      responses: { [`GET ${DEFINITION}`]: () => ({ status: 502, body: { m: BODY_MARKER } }) },
    }),
  ]) {
    const { promise, writes, logs } = run(cloud, { mode: "delete", confirm: CONFIRMATION });
    try {
      await promise;
    } catch (error) {
      outputs.push(error.message);
    }
    outputs.push(JSON.stringify(writes), ...logs);
  }
  const text = outputs.join("\n");
  assert(text.length > 0);
  for (const secret of [TOKEN, BODY_MARKER, ACCOUNT, "Bearer"]) assert(!text.includes(secret));
});

test("plan output is independent of the order Cloudflare reports counts in", async () => {
  const counts = workflowBody().instances;
  const reversed = Object.fromEntries(Object.entries(counts).reverse());
  const a = await planRetirement(guard(account().api, "dry-run"), () => NOW);
  const b = await planRetirement(
    guard(account({ workflow: workflowBody({ instances: reversed }) }).api, "dry-run"),
    () => NOW,
  );
  assert.deepEqual(Object.keys(a.workflow.instanceCounts), Object.keys(b.workflow.instanceCounts));
  assert.deepEqual(Object.keys(a.workflow.instanceCounts), Object.keys(counts).sort());
});

const cli = (script, env) =>
  spawnSync(process.execPath, [path.join(ROOT, "eng", script), ...(env.args ?? [])], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot ?? "",
      CI: "true",
      ...env.vars,
    },
  });

test("the retirement CLI refuses a delete without confirmation before credentials", () => {
  const evidence = path.join(ROOT, "artifacts/retirement");
  const before = fs.existsSync(evidence);
  const result = cli("retire.mjs", { vars: { RETIRE_MODE: "delete", RETIRE_CONFIRM: "yes" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /confirmation "delete arcforges-ai-hello" exactly/u);
  assert.doesNotMatch(result.stderr, /CLOUDFLARE/u);
  assert.equal(fs.existsSync(evidence), before);
});

test("deploy refuses because arcforges-ai-hello is retired", async () => {
  await assert.rejects(deploy(), /^Error: arcforges-ai-hello is retired \(HAR\.40\)/u);
  const result = cli("cloudflare.mjs", {
    args: ["deploy"],
    vars: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /arcforges-ai-hello is retired \(HAR\.40\); no deployment is made\./u,
  );
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(TOKEN, "u"));
});
