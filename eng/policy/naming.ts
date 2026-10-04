// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Finding, PUBLIC_WIRE_PACKAGE } from "./architecture.ts";

export interface NamingCandidate {
  package: string;
  version: string;
  sourceCommit: string;
  publication: string;
  assets: Record<string, string>;
}
/** Bytes observed in the installed published package; undefined when absent. */
export interface InstalledNaming {
  packageJson: string | undefined;
  sourceJson: string | undefined;
  assets: Record<string, Uint8Array | undefined>;
}

export const NAMING_ASSETS = [
  "tools/naming/eng/check_naming.py",
  "tools/naming/eng/policy/product-names.json",
] as const;
const file = "eng/policy/naming-candidate.json";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * WP-05.02: the scanner and the policy are consumed only as the published,
 * build-only assets of the exact pinned producer. Package version, producer
 * commit and both asset hashes are compared before anything executes.
 */
export function auditNamingCandidate(
  candidate: unknown,
  installed: InstalledNaming,
  pin: string | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const report = (detail: string) => findings.push({ rule: "naming-identity", file, detail });
  const record = candidate as Partial<NamingCandidate> | null;
  if (
    typeof record !== "object" ||
    record === null ||
    Object.keys(record).sort().join() !== "assets,package,publication,sourceCommit,version"
  ) {
    report(
      "Candidate record must have exactly package, version, sourceCommit, publication, assets",
    );
    return findings;
  }
  if (record.package !== PUBLIC_WIRE_PACKAGE)
    report(`Unexpected producer package: ${record.package}`);
  if (typeof record.version !== "string" || record.version !== pin)
    report("Candidate version must equal the exact dependency pin");
  if (!/^[0-9a-f]{40}$/u.test(String(record.sourceCommit)))
    report("Producer source commit is not a full SHA");
  if (
    !/^https:\/\/github\.com\/ArcForges\/Contracts\/actions\/runs\/[1-9]\d*$/u.test(
      String(record.publication),
    )
  )
    report("Publication receipt must be an ArcForges/Contracts workflow run");
  const assets = record.assets;
  if (
    typeof assets !== "object" ||
    assets === null ||
    Object.keys(assets).sort().join() !== [...NAMING_ASSETS].sort().join()
  ) {
    report("Asset set must be exactly the published scanner and policy");
    return findings;
  }
  for (const [name, expected] of Object.entries(assets)) {
    if (!/^[0-9a-f]{64}$/u.test(expected)) report(`Malformed asset hash: ${name}`);
    const bytes = installed.assets[name];
    if (!bytes) report(`Published asset is not installed: ${name}`);
    else if (sha256(bytes) !== expected) report(`Naming asset changed: ${name}`);
  }
  try {
    const manifest = JSON.parse(installed.packageJson ?? "null") as {
      name?: string;
      version?: string;
    };
    if (manifest.name !== PUBLIC_WIRE_PACKAGE || manifest.version !== record.version)
      report("Installed package identity differs from the candidate");
  } catch {
    report("Installed package manifest is unreadable");
  }
  try {
    const source = JSON.parse(installed.sourceJson ?? "null") as {
      repository?: string;
      commit?: string;
      version?: string;
      dirty?: boolean;
    };
    if (
      source.repository !== "https://github.com/ArcForges/Contracts" ||
      source.commit !== record.sourceCommit ||
      source.version !== record.version ||
      source.dirty !== false
    )
      report("Installed producer source identity differs from the candidate");
  } catch {
    report("Installed producer source identity is unreadable");
  }
  return findings;
}

export function readInstalledNaming(root: string): InstalledNaming {
  const base = path.join(root, "node_modules", PUBLIC_WIRE_PACKAGE);
  const text = (name: string) => {
    const target = path.join(base, name);
    return existsSync(target) ? readFileSync(target, "utf8") : undefined;
  };
  return {
    packageJson: text("package.json"),
    sourceJson: text("source.json"),
    assets: Object.fromEntries(
      NAMING_ASSETS.map((name) => {
        const target = path.join(base, name);
        return [name, existsSync(target) ? readFileSync(target) : undefined];
      }),
    ),
  };
}

export function verifyNamingCandidate(root: string): Finding[] {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  let candidate: unknown = null;
  try {
    candidate = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  } catch {
    // Reported by the identity check as a malformed record.
  }
  return auditNamingCandidate(
    candidate,
    readInstalledNaming(root),
    manifest.dependencies?.[PUBLIC_WIRE_PACKAGE],
  );
}

export function pythonCommand(): string {
  for (const command of ["python3", "python"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0 && /^Python 3\./u.test(`${probe.stdout}${probe.stderr}`)) return command;
  }
  throw new Error("The published naming scanner requires Python 3 on PATH.");
}

export interface ScanResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the exact installed published scanner over one real Git root. */
export function runNamingScan(root: string, target: string, reportPath?: string): ScanResult {
  const scanner = path.join(root, "node_modules", PUBLIC_WIRE_PACKAGE, NAMING_ASSETS[0]);
  const args = [scanner, "--repository", `AI=${target}`];
  if (reportPath) {
    mkdirSync(path.dirname(reportPath), { recursive: true });
    args.push("--report", reportPath);
  }
  const result = spawnSync(pythonCommand(), args, { encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function auditNamingScan(root: string, reportPath: string): Finding[] {
  const result = runNamingScan(root, root, reportPath);
  if (result.status === 0) return [];
  return [
    {
      rule: "naming-scan",
      file: ".",
      detail: `Published scanner reported findings (exit ${result.status}): ${`${result.stdout}${result.stderr}`.trim().slice(0, 600)}`,
    },
  ];
}

/** The scanner's own policy terms, read from the verified installed asset. */
export function forbiddenNames(root: string): string[] {
  const policy = JSON.parse(
    readFileSync(path.join(root, "node_modules", PUBLIC_WIRE_PACKAGE, NAMING_ASSETS[1]), "utf8"),
  ) as { forbiddenNames: { name: string }[] };
  return policy.forbiddenNames.map((item) => item.name);
}

export function writeEvidence(target: string, value: unknown) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}
