// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import path from "node:path";
import { auditRepository, type Finding } from "./architecture.ts";
import { applyExceptions } from "./exceptions.ts";
import { auditNamingScan, verifyNamingCandidate, writeEvidence } from "./naming.ts";

export interface PolicyReport {
  repository: "AI";
  inventoryFiles: number;
  rules: number;
  exceptionsApplied: number;
  findings: Finding[];
}

/**
 * The AI repository policy gate wired into `eng/project.mjs check`: layering,
 * licence boundary, generated-client consumption and banned APIs over the real
 * Git inventory, then the published naming scanner under verified identity.
 * Nothing here contacts a network, Workers AI or any live service.
 */
export function runPolicy(
  root: string,
  today = new Date().toISOString().slice(0, 10),
): PolicyReport {
  const audit = auditRepository(root);
  const document = JSON.parse(
    readFileSync(path.join(root, "eng/policy/exceptions.json"), "utf8"),
  ) as unknown;
  const { remaining, problems } = applyExceptions(audit.findings, document, today);
  const findings = [...remaining, ...problems, ...verifyNamingCandidate(root)];
  // The scanner is executed only after the producer identity has been proven.
  if (!findings.some((finding) => finding.rule === "naming-identity"))
    findings.push(...auditNamingScan(root, path.join(root, "artifacts/evidence/naming.json")));
  const report: PolicyReport = {
    repository: "AI",
    inventoryFiles: audit.inventoryFiles,
    rules: audit.rules,
    exceptionsApplied: audit.findings.length - remaining.length,
    findings,
  };
  writeEvidence(path.join(root, "artifacts/evidence/architecture.json"), report);
  if (findings.length > 0)
    throw new Error(`Architecture policy findings:\n${JSON.stringify(findings, null, 2)}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const report = runPolicy(process.cwd());
  console.log(
    `Architecture policy passed: ${report.rules} rules over ${report.inventoryFiles} inventoried files, no findings.`,
  );
}
