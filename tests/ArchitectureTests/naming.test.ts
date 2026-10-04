// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  auditNamingScan,
  forbiddenNames,
  runNamingScan,
  verifyNamingCandidate,
} from "../../eng/policy/naming.ts";

const root = path.resolve(import.meta.dirname, "../..");

it("the installed published scanner and policy match the recorded producer identity", () => {
  expect(verifyNamingCandidate(root)).toEqual([]);
});

it("the published scanner reports zero findings on the current repository", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ai-naming-report-"));
  try {
    expect(auditNamingScan(root, path.join(scratch, "naming.json"))).toEqual([]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("the published scanner accepts current terms and detects every forbidden term", () => {
  const terms = forbiddenNames(root);
  expect(terms.length).toBeGreaterThan(0);
  const fixture = mkdtempSync(path.join(os.tmpdir(), "ai-naming-"));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ai-naming-report-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: fixture, windowsHide: true, stdio: "pipe" });
  try {
    expect(path.dirname(fixture)).toBe(path.resolve(os.tmpdir()));
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/ArcForges/AI.git");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    const probe = path.join(fixture, "probe.txt");
    const scan = () => runNamingScan(root, fixture, path.join(scratch, "report.json"));
    writeFileSync(probe, "ArcForges ArcScope");
    expect(scan().status).toBe(0);
    for (const term of terms) {
      writeFileSync(probe, `prefix ${term} suffix`);
      const result = scan();
      expect(result.status, term).toBe(1);
      expect(result.stdout, term).toContain('"kind": "forbidden content"');
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

const eol = os.EOL;

it("a failing published scanner becomes a naming-scan finding and a passing one does not", () => {
  const fake = mkdtempSync(path.join(os.tmpdir(), "ai-naming-fake-"));
  const scanner = path.join(fake, "node_modules/@arcforges/proto/tools/naming/eng/check_naming.py");
  const report = path.join(fake, "report.json");
  try {
    mkdirSync(path.dirname(scanner), { recursive: true });
    writeFileSync(scanner, ["import sys", 'print("finding")', "sys.exit(1)", ""].join(eol));
    const failed = auditNamingScan(fake, report);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.rule).toBe("naming-scan");
    expect(failed[0]?.detail).toContain("exit 1");
    writeFileSync(scanner, ["import sys", "sys.exit(0)", ""].join(eol));
    expect(auditNamingScan(fake, report)).toEqual([]);
  } finally {
    rmSync(fake, { recursive: true, force: true });
  }
});
