// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditRepository, RULES } from "../../eng/policy/architecture.ts";
import { runPolicy } from "../../eng/policy/run.ts";
import { baseline } from "./fixtures.ts";

const root = path.resolve(import.meta.dirname, "../..");

describe("real Git inventory", () => {
  it("the current repository satisfies every architecture rule", () => {
    const report = auditRepository(root);
    expect(report.findings).toEqual([]);
    expect(report.rules).toBe(RULES.length);
    expect(report.inventoryFiles).toBeGreaterThan(50);
  });

  it("the complete gate passes with the verified published naming scanner", () => {
    expect(runPolicy(root, "2026-10-04").findings).toEqual([]);
  });

  it("reads tracked and nonignored files and skips ignored ones", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "ai-inventory-"));
    const write = (name: string, content: string) => {
      mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
      writeFileSync(path.join(fixture, name), content);
    };
    try {
      execFileSync("git", ["init", "-q"], { cwd: fixture, windowsHide: true });
      for (const [name, content] of Object.entries(baseline())) write(name, content);
      write(".gitignore", "artifacts/\n");
      expect(auditRepository(fixture).findings).toEqual([]);

      // Ignored output is never inventoried, so a violation there is not seen.
      write("artifacts/bad.ts", 'import "node:fs";\n');
      expect(auditRepository(fixture).findings).toEqual([]);

      // An untracked but not ignored file is part of the inventory.
      write("src/bad.ts", 'import "node:fs";\n');
      expect(auditRepository(fixture).findings.map((finding) => finding.rule)).toContain(
        "layer-runtime-dependency",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
