// SPDX-License-Identifier: AGPL-3.0-only
import { type Finding, RULES } from "./architecture.ts";

export interface PolicyException {
  id: string;
  rule: string;
  file: string;
  detail: string;
  owner: string;
  reason: string;
  created: string;
  expires: string;
}
export interface ExceptionDocument {
  schemaVersion: 1;
  exceptions: PolicyException[];
}

/** Rule ids that govern the exception file itself. */
export const EXCEPTION_RULES = [
  "exception-invalid",
  "exception-expired",
  "exception-lifetime",
  "exception-unused",
] as const;
export const MAX_EXCEPTION_DAYS = 180;

const day = /^\d{4}-\d{2}-\d{2}$/u;
const milliseconds = (value: string) => Date.parse(`${value}T00:00:00Z`);
const fields = ["id", "rule", "file", "detail", "owner", "reason", "created", "expires"];

export interface ExceptionResult {
  remaining: Finding[];
  problems: Finding[];
}

/**
 * An exception names one exact finding, an owner, a reason and a bounded
 * lifetime. Expired, invalid and unused entries are themselves findings, so an
 * exception can never silently outlive the condition it covers.
 */
export function applyExceptions(
  findings: Finding[],
  document: unknown,
  today: string,
): ExceptionResult {
  const problems: Finding[] = [];
  const file = "eng/policy/exceptions.json";
  const problem = (rule: (typeof EXCEPTION_RULES)[number], detail: string) =>
    problems.push({ rule, file, detail });
  const root = document as Partial<ExceptionDocument> | null;
  if (
    typeof root !== "object" ||
    root === null ||
    Object.keys(root).sort().join() !== "exceptions,schemaVersion" ||
    root.schemaVersion !== 1 ||
    !Array.isArray(root.exceptions)
  ) {
    problem("exception-invalid", "Expected exactly schemaVersion 1 and an exceptions array");
    return { remaining: findings, problems };
  }
  const known = new Set(RULES.map((rule) => rule.id));
  const ids = new Set<string>();
  const used = new Set<string>();
  let remaining = findings;
  for (const raw of root.exceptions as unknown[]) {
    const item = raw as Record<string, unknown>;
    const label = typeof item?.id === "string" ? item.id : "(unnamed)";
    if (
      typeof item !== "object" ||
      item === null ||
      Object.keys(item).sort().join() !== [...fields].sort().join() ||
      fields.some((name) => typeof item[name] !== "string" || String(item[name]).trim() === "")
    ) {
      problem("exception-invalid", `${label}: every field is required and must be text`);
      continue;
    }
    const entry = item as unknown as PolicyException;
    if (ids.has(entry.id)) problem("exception-invalid", `${entry.id}: duplicate id`);
    ids.add(entry.id);
    if (!known.has(entry.rule))
      problem("exception-invalid", `${entry.id}: unknown rule ${entry.rule}`);
    if (entry.reason.length < 20 || entry.owner.length < 3)
      problem("exception-invalid", `${entry.id}: owner and a substantive reason are required`);
    if (!day.test(entry.created) || !day.test(entry.expires)) {
      problem("exception-invalid", `${entry.id}: dates must be YYYY-MM-DD`);
      continue;
    }
    const lifetime = (milliseconds(entry.expires) - milliseconds(entry.created)) / 86_400_000;
    if (!(lifetime > 0) || lifetime > MAX_EXCEPTION_DAYS)
      problem("exception-lifetime", `${entry.id}: lifetime must be 1-${MAX_EXCEPTION_DAYS} days`);
    if (milliseconds(entry.expires) < milliseconds(today)) {
      problem("exception-expired", `${entry.id}: expired ${entry.expires}`);
      continue;
    }
    const before = remaining.length;
    remaining = remaining.filter(
      (finding) =>
        !(
          finding.rule === entry.rule &&
          finding.file === entry.file &&
          finding.detail === entry.detail
        ),
    );
    if (remaining.length === before) problem("exception-unused", `${entry.id}: matches no finding`);
    else used.add(entry.id);
  }
  return { remaining, problems };
}
