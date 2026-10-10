// SPDX-License-Identifier: AGPL-3.0-only
// HAR.40 retirement of the arcforges-ai-hello Worker and Workflow. Run only by
// .github/workflows/retire-cloudflare.yml: a read-only plan in dry-run mode, and
// in delete mode the same plan followed by the Workflow and Worker deletion.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createApi, credentials } from "./cloudflare.mjs";
import { ROOT, readJson, writeJson } from "./project.mjs";

// The targets are constants checked against wrangler.json, never inputs.
export const WORKER = "arcforges-ai-hello";
export const WORKFLOW = "arcforges-ai-hello";
export const CONFIRMATION = `delete ${WORKER}`;
export const MODES = Object.freeze(["dry-run", "delete"]);
// Cloudflare Workflows instance statuses. Any other reported status (including
// the runtime's "unknown") is not proven terminal and refuses the retirement.
export const NON_TERMINAL = Object.freeze([
  "queued",
  "running",
  "waiting",
  "paused",
  "waitingForPause",
]);
export const TERMINAL = Object.freeze(["complete", "errored", "terminated"]);
export const DRAIN_DAYS = 7;
export const DRAIN_MS = DRAIN_DAYS * 24 * 60 * 60 * 1000;
export const PAGE_SIZE = 100;
export const HISTORY_PAGES = 10;
export const VERIFY_ATTEMPTS = 6;
export const VERIFY_INTERVAL_MS = 5000;

const EVIDENCE = path.join(ROOT, "artifacts/retirement");
const SCRIPT = `/workers/scripts/${WORKER}`;
const SETTINGS = `${SCRIPT}/settings`;
const DEFINITION = `/workflows/${WORKFLOW}`;
const TIMESTAMPS = ["created_on", "modified_on", "started_on", "ended_on"];

export function instancesPath(status, page) {
  return `${DEFINITION}/instances?status=${status}&per_page=${PAGE_SIZE}&page=${page}`;
}

const ALLOWED = Object.freeze({
  GET: new Set([
    SETTINGS,
    DEFINITION,
    ...NON_TERMINAL.map((status) => instancesPath(status, 1)),
    ...TERMINAL.flatMap((status) =>
      Array.from({ length: HISTORY_PAGES }, (_, index) => instancesPath(status, index + 1)),
    ),
  ]),
  // Deleting the Worker never sends force=true: Cloudflare then refuses while
  // anything still binds to it.
  DELETE: new Set([DEFINITION, SCRIPT]),
});

export function allowed(method, suffix) {
  return Object.hasOwn(ALLOWED, method) && ALLOWED[method].has(suffix);
}

export class RetirementRefused extends Error {}

export function checkInputs(mode, confirm) {
  if (!MODES.includes(mode))
    throw new RetirementRefused("Mode must be dry-run or delete; no request was sent.");
  if (mode === "delete" && confirm !== CONFIRMATION)
    throw new RetirementRefused(
      `Delete requires the confirmation "${CONFIRMATION}" exactly; no request was sent.`,
    );
}

export function checkConfig(config) {
  assert.equal(config?.name, WORKER, "wrangler.json no longer names the retired Worker.");
  assert(
    Array.isArray(config.workflows) && config.workflows.length === 1,
    "wrangler.json must declare exactly the retired Workflow.",
  );
  assert.equal(config.workflows[0].name, WORKFLOW, "wrangler.json names another Workflow.");
  assert.equal(
    config.workflows[0].script_name,
    undefined,
    "The retired Workflow must be served by its own Worker.",
  );
}

// Restricts every request to the allowlisted endpoints, and dry-run to GET.
export function guard(api, mode) {
  return async (suffix, options = {}) => {
    const method = options.method ?? "GET";
    assert(allowed(method, suffix), "Request outside the retirement allowlist was refused.");
    assert(mode === "delete" || method === "GET", "Dry-run sends only GET requests.");
    return api(suffix, options);
  };
}

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const label = (value) => (/^[A-Za-z]{1,32}$/u.test(value) ? value : "unrecognized");
const iso = (ms) => new Date(ms).toISOString();

function time(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function inspectRows(rows, status, reasons, activity, seen) {
  if (!Array.isArray(rows)) {
    reasons.push(`The ${status} instance listing is malformed.`);
    return 0;
  }
  for (const row of rows) {
    if (!record(row) || typeof row.id !== "string" || row.id.length === 0) {
      reasons.push(`The ${status} instance listing contains a malformed instance.`);
      continue;
    }
    if (seen.has(row.id)) {
      reasons.push(`The ${status} instance listing repeated an instance; paging is unproven.`);
      continue;
    }
    seen.add(row.id);
    if (row.status !== status)
      reasons.push(
        `The ${status} instance listing returned status ${label(String(row.status))}; it is not proven terminal.`,
      );
    const times = [];
    for (const field of TIMESTAMPS) {
      const value = row[field];
      if (value === undefined || (value === null && field !== "created_on")) continue;
      const ms = time(value);
      if (ms === null) reasons.push(`An instance reports a malformed ${field}.`);
      else times.push(ms);
    }
    if (times.length === 0) reasons.push("An instance reports no activity time.");
    activity.push(...times);
  }
  return rows.length;
}

// Read-only. Refuses on any non-terminal or unknown instance, on unproven
// paging, and on activity inside the drain horizon (computed client-side).
export async function planRetirement(api, now = Date.now) {
  const reasons = [];
  const activity = [];
  const plan = {
    schemaVersion: 1,
    kind: "arcforges-ai-hello-retirement-plan",
    task: "HAR.40",
    worker: { name: WORKER, present: false },
    workflow: { name: WORKFLOW, present: false },
    drainHorizonDays: DRAIN_DAYS,
  };
  plan.worker.present = (await api(SETTINGS, { allowMissing: true })) !== null;
  const workflow = await api(DEFINITION, { allowMissing: true });
  plan.workflow.present = workflow !== null;
  if (plan.workflow.present) {
    if (!record(workflow)) reasons.push("The Workflow definition is malformed.");
    else {
      if (workflow.name !== WORKFLOW) reasons.push("Cloudflare returned another Workflow.");
      if (workflow.script_name !== WORKER)
        reasons.push(`The Workflow is not served by the ${WORKER} Worker.`);
      else plan.workflow.scriptName = WORKER;
      if (!Object.hasOwn(workflow, "triggered_on"))
        reasons.push("The Workflow does not report its last trigger time.");
      else if (workflow.triggered_on === null) plan.workflow.triggeredOn = null;
      else {
        const ms = time(workflow.triggered_on);
        if (ms === null) reasons.push("The Workflow reports a malformed trigger time.");
        else {
          plan.workflow.triggeredOn = iso(ms);
          activity.push(ms);
        }
      }
      if (!record(workflow.instances))
        reasons.push("The Workflow does not report its instance counts.");
      else {
        const counts = {};
        for (const status of Object.keys(workflow.instances).sort()) {
          const count = workflow.instances[status];
          if (!Number.isSafeInteger(count) || count < 0) {
            reasons.push(`The ${label(status)} instance count is malformed.`);
            continue;
          }
          counts[label(status)] = count;
          if (count === 0) continue;
          if (NON_TERMINAL.includes(status))
            reasons.push(`${count} ${status} instance(s) are not terminal.`);
          else if (!TERMINAL.includes(status))
            reasons.push(
              `${count} instance(s) report status ${label(status)}; not proven terminal.`,
            );
        }
        plan.workflow.instanceCounts = counts;
      }
    }
    const seen = new Set();
    plan.nonTerminalListed = {};
    for (const status of NON_TERMINAL) {
      const count = inspectRows(
        await api(instancesPath(status, 1)),
        status,
        reasons,
        activity,
        seen,
      );
      plan.nonTerminalListed[status] = count;
      if (count > 0)
        reasons.push(
          `${count}${count >= PAGE_SIZE ? " or more" : ""} ${status} instance(s) are listed.`,
        );
    }
    plan.terminalListed = {};
    for (const status of TERMINAL) {
      let total = 0;
      for (let page = 1; ; page++) {
        const count = inspectRows(
          await api(instancesPath(status, page)),
          status,
          reasons,
          activity,
          seen,
        );
        total += count;
        if (count < PAGE_SIZE) break;
        if (page === HISTORY_PAGES) {
          reasons.push(`The ${status} history exceeds ${HISTORY_PAGES} full pages; refusing.`);
          break;
        }
      }
      plan.terminalListed[status] = total;
    }
  }
  const checkedAt = now();
  plan.checkedAt = iso(checkedAt);
  plan.latestActivity = activity.length > 0 ? iso(Math.max(...activity)) : null;
  if (activity.length > 0) {
    const latest = Math.max(...activity);
    plan.eligibleAfter = iso(latest + DRAIN_MS);
    if (checkedAt - latest < DRAIN_MS)
      reasons.push(
        `The latest activity ${iso(latest)} is inside the ${DRAIN_DAYS}-day drain horizon; retry after ${iso(latest + DRAIN_MS)}.`,
      );
  }
  plan.decision =
    reasons.length > 0
      ? "refused"
      : plan.worker.present || plan.workflow.present
        ? "eligible"
        : "already-retired";
  plan.reasons = reasons;
  return plan;
}

async function verifyAbsent(api, wait) {
  for (let attempt = 1; ; attempt++) {
    const workflow = await api(DEFINITION, { allowMissing: true });
    const worker = await api(SETTINGS, { allowMissing: true });
    if (workflow === null && worker === null) return attempt;
    assert(
      attempt < VERIFY_ATTEMPTS,
      "Cloudflare still reports the retired Workflow or Worker after deletion.",
    );
    await wait(VERIFY_INTERVAL_MS);
  }
}

function summarize(plan, log) {
  log(
    `Retirement plan: ${plan.decision}; Worker present ${plan.worker.present}; Workflow present ${plan.workflow.present}; latest activity ${plan.latestActivity ?? "none"}.`,
  );
  for (const reason of plan.reasons) log(`Refusal: ${reason}`);
}

export async function retire({
  mode,
  confirm,
  api,
  config,
  now = Date.now,
  wait = delay,
  write = () => {},
  log = () => {},
}) {
  // Inputs are checked before any network call.
  checkInputs(mode, confirm);
  checkConfig(config);
  const guarded = guard(api, mode);
  // Delete never reuses an earlier dry-run: it plans again in this run.
  const plan = await planRetirement(guarded, now);
  write("plan.json", plan);
  summarize(plan, log);
  const result = {
    schemaVersion: 1,
    kind: "arcforges-ai-hello-retirement-result",
    task: "HAR.40",
    mode,
    planDecision: plan.decision,
    steps: [],
  };
  if (plan.decision === "refused") {
    if (mode === "delete") write("result.json", { ...result, outcome: "refused" });
    throw new RetirementRefused(
      `Retirement refused: ${plan.reasons.length} condition(s); see plan.json.`,
    );
  }
  if (mode === "dry-run") {
    log("Dry-run complete; no request other than GET was sent.");
    return { plan };
  }
  try {
    if (plan.workflow.present) {
      await guarded(DEFINITION, { method: "DELETE" });
      result.steps.push({ action: "delete-workflow", outcome: "deleted", at: iso(now()) });
    } else result.steps.push({ action: "delete-workflow", outcome: "already-absent" });
    if (plan.worker.present) {
      await guarded(SCRIPT, { method: "DELETE" });
      result.steps.push({ action: "delete-worker", outcome: "deleted", at: iso(now()) });
    } else result.steps.push({ action: "delete-worker", outcome: "already-absent" });
    const attempts = await verifyAbsent(guarded, wait);
    result.steps.push({ action: "verify-absent", outcome: "not-found", attempts, at: iso(now()) });
    result.outcome = plan.decision === "eligible" ? "deleted" : "already-retired";
  } catch (error) {
    result.outcome = "failed";
    result.error = error instanceof Error ? error.message : "Retirement step failed.";
    write("result.json", result);
    throw error;
  }
  write("result.json", result);
  log(`Retirement ${result.outcome}: the Workflow and Worker return 404.`);
  return { plan, result };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let token;
  // Defence in depth: no message or record is expected to contain the token.
  const redact = (text) => (token ? text.replaceAll(token, "[REDACTED]") : text);
  try {
    const mode = process.env.RETIRE_MODE ?? "dry-run";
    const confirm = process.env.RETIRE_CONFIRM ?? "";
    checkInputs(mode, confirm);
    fs.rmSync(EVIDENCE, { recursive: true, force: true });
    const auth = credentials();
    token = auth.token;
    await retire({
      mode,
      confirm,
      api: createApi(auth),
      config: readJson(path.join(ROOT, "wrangler.json")),
      write: (name, value) =>
        writeJson(path.join(EVIDENCE, name), JSON.parse(redact(JSON.stringify(value)))),
      log: (line) => console.log(redact(line)),
    });
  } catch (error) {
    console.error(redact(error instanceof Error ? error.message : "Retirement failed."));
    process.exitCode = 1;
  }
}
