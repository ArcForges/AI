// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditArchitecture, licenceAllowed, RULES } from "../../eng/policy/architecture.ts";
import { baseline, fixtures } from "./fixtures.ts";

const root = path.resolve(import.meta.dirname, "../..");

describe("AI architecture policy fixtures", () => {
  it("accepts the minimal compliant repository", () => {
    expect(auditArchitecture(baseline())).toEqual([]);
  });

  for (const fixture of fixtures)
    it(`${fixture.rule}: ${fixture.kind} - ${fixture.name}`, () => {
      const findings = fixture.run();
      if (fixture.kind === "pass") expect(findings).toEqual([]);
      else expect(findings.map((finding) => finding.rule)).toContain(fixture.rule);
    });

  it("gives every rule a passing and a refused fixture", () => {
    for (const rule of RULES) {
      const own = fixtures.filter((fixture) => fixture.rule === rule.id);
      if (rule.id === "naming-scan") continue; // exercised against the real scanner in naming.test.ts
      expect(
        own.some((fixture) => fixture.kind === "pass"),
        `${rule.id} has no passing fixture`,
      ).toBe(true);
      expect(
        own.some((fixture) => fixture.kind === "fail"),
        `${rule.id} has no refused fixture`,
      ).toBe(true);
    }
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);
    for (const fixture of fixtures)
      expect(
        RULES.some((rule) => rule.id === fixture.rule),
        `unknown rule ${fixture.rule}`,
      ).toBe(true);
  });

  it("documents every rule in the policy description", () => {
    const description = readFileSync(path.join(root, "eng/policy/architecture.md"), "utf8");
    for (const rule of RULES) expect(description, rule.id).toContain(`\`${rule.id}\``);
  });

  it("covers all five WP-05 obligations", () => {
    expect(new Set(RULES.map((rule) => rule.obligation))).toEqual(
      new Set(["WP-05.00", "WP-05.01", "WP-05.02", "WP-05.03", "WP-05.04"]),
    );
  });
});

describe("SPDX expression evaluation", () => {
  const allowed = new Set(["MIT", "Apache-2.0", "BSD-3-Clause"]);
  it("requires one alternative of OR and every term of AND", () => {
    expect(licenceAllowed("MIT OR GPL-3.0-only", allowed)).toBe(true);
    expect(licenceAllowed("(Apache-2.0 AND BSD-3-Clause)", allowed)).toBe(true);
    expect(licenceAllowed("MIT AND GPL-3.0-only", allowed)).toBe(false);
    expect(licenceAllowed("GPL-3.0-only", allowed)).toBe(false);
  });
  it("refuses empty, malformed and WITH-exception expressions", () => {
    expect(licenceAllowed(undefined, allowed)).toBe(false);
    expect(licenceAllowed("", allowed)).toBe(false);
    expect(licenceAllowed("(MIT", allowed)).toBe(false);
    expect(licenceAllowed("MIT OR", allowed)).toBe(false);
    expect(licenceAllowed("MIT WITH Classpath-exception-2.0", allowed)).toBe(false);
  });
});
