// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../eng/policy/architecture.ts";
import { applyExceptions, MAX_EXCEPTION_DAYS } from "../../eng/policy/exceptions.ts";

const finding: Finding = {
  rule: "banned-reflection",
  file: "src/x.ts",
  detail: "Reflect entry point",
};
const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "AI-EX-1",
  rule: "banned-reflection",
  file: "src/x.ts",
  detail: "Reflect entry point",
  owner: "AI architecture owner",
  reason: "Bounded migration of a reviewed legacy adapter",
  created: "2026-10-01",
  expires: "2026-12-01",
  ...overrides,
});
const document = (...exceptions: unknown[]) => ({ schemaVersion: 1, exceptions });
const rules = (value: { problems: Finding[] }) => value.problems.map((problem) => problem.rule);

describe("owned expiring exceptions", () => {
  it("ships an empty, valid exception file", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const file = JSON.parse(readFileSync(path.join(root, "eng/policy/exceptions.json"), "utf8"));
    expect(applyExceptions([], file, "2026-10-04")).toEqual({ remaining: [], problems: [] });
    expect(file.exceptions).toEqual([]);
  });

  it("suppresses exactly the named finding while valid", () => {
    const other: Finding = { ...finding, file: "src/y.ts" };
    const result = applyExceptions([finding, other], document(entry()), "2026-10-04");
    expect(result.remaining).toEqual([other]);
    expect(result.problems).toEqual([]);
  });

  it("stops suppressing and reports an expired exception", () => {
    const result = applyExceptions([finding], document(entry()), "2026-12-02");
    expect(result.remaining).toEqual([finding]);
    expect(rules(result)).toEqual(["exception-expired"]);
  });

  it("reports an exception that no longer matches a finding", () => {
    const result = applyExceptions([], document(entry()), "2026-10-04");
    expect(rules(result)).toEqual(["exception-unused"]);
  });

  it("bounds the lifetime", () => {
    const long = entry({ expires: "2027-12-01" });
    expect(rules(applyExceptions([finding], document(long), "2026-10-04"))).toContain(
      "exception-lifetime",
    );
    expect(MAX_EXCEPTION_DAYS).toBe(180);
    expect(
      rules(applyExceptions([finding], document(entry({ expires: "2026-10-01" })), "2026-10-04")),
    ).toContain("exception-lifetime");
  });

  it("rejects a creation date in the future, which would defeat the lifetime cap", () => {
    const future = entry({ created: "2027-01-01", expires: "2027-03-01" });
    const result = applyExceptions([finding], document(future), "2026-10-04");
    expect(rules(result)).toContain("exception-invalid");
  });

  it("rejects malformed documents and entries", () => {
    expect(rules(applyExceptions([], null, "2026-10-04"))).toEqual(["exception-invalid"]);
    expect(rules(applyExceptions([], { schemaVersion: 2, exceptions: [] }, "2026-10-04"))).toEqual([
      "exception-invalid",
    ]);
    expect(
      rules(applyExceptions([], { schemaVersion: 1, exceptions: [], extra: 1 }, "2026-10-04")),
    ).toEqual(["exception-invalid"]);
    for (const bad of [
      entry({ owner: "" }),
      entry({ reason: "short" }),
      entry({ rule: "no-such-rule" }),
      entry({ expires: "tomorrow" }),
      { ...entry(), extra: "field" },
    ])
      expect(rules(applyExceptions([finding], document(bad), "2026-10-04"))).toContain(
        "exception-invalid",
      );
    expect(rules(applyExceptions([finding], document(entry(), entry()), "2026-10-04"))).toContain(
      "exception-invalid",
    );
  });
});
