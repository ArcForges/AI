// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { auditLicences } from "../licence-boundary.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ai-licence-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith("ai-licence-test-"));
    rmSync(root, { recursive: true });
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true });
  git("init", "-q");
  git(
    "-c",
    "user.name=Licence Test",
    "-c",
    "user.email=licence@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  );
  const write = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), JSON.stringify(value));
  };
  const policy = {
    schemaVersion: 1,
    repository: "AI",
    spdxLicense: "AGPL-3.0-only",
    licenceBoundary: "AGPL",
    projects: [{ path: "package.json", kind: "npm" }],
  };
  const manifest = {
    name: "@arcforges/ai",
    license: "AGPL-3.0-only",
    arcforges: { licenceBoundary: "AGPL" },
  };
  write("eng/policy/licence-boundary.json", policy);
  write("package.json", manifest);
  return { root, write, policy, manifest };
}

test("actual Git inventory covers the complete npm project", (t) => {
  const { root } = fixture(t);
  assert.equal(auditLicences(root).projects.length, 1);
});

for (const value of [null, "Apache"])
  test(`missing/inconsistent boundary fails: ${value}`, (t) => {
    const { root, write, manifest } = fixture(t);
    manifest.arcforges.licenceBoundary = value;
    write("package.json", manifest);
    assert.throws(() => auditLicences(root), /Incorrect boundary/u);
  });

test("edited repository assignment cannot authorize another boundary", (t) => {
  const { root, write, policy } = fixture(t);
  policy.licenceBoundary = "Apache";
  write("eng/policy/licence-boundary.json", policy);
  assert.throws(() => auditLicences(root));
});

test("new nonignored projects and duplicate registrations fail", (t) => {
  const { root, write, manifest, policy } = fixture(t);
  write("tools/package.json", { ...manifest, name: "@arcforges/tool" });
  assert.throws(() => auditLicences(root), /inventory drift/u);
  policy.projects.push(policy.projects[0]);
  write("eng/policy/licence-boundary.json", policy);
  assert.throws(() => auditLicences(root), /inventory drift/u);
});

test("locked transitive first-party owner must be known", (t) => {
  const { root, write } = fixture(t);
  write("package-lock.json", { packages: { "node_modules/@arcforges/unknown": {} } });
  assert.throws(() => auditLicences(root), /Unknown first-party/u);
});

for (const version of ["file:../source", "npm:@arcforges/unknown", "npm:@arcforges/unknown@1.0.0"])
  test(`unpublished or hidden unknown dependency fails: ${version}`, (t) => {
    const { root, write, manifest } = fixture(t);
    write("package.json", { ...manifest, dependencies: { alias: version } });
    assert.throws(() => auditLicences(root), /Unpublished|Unknown first-party/u);
  });

test("an introduced build system needs its owning verifier", (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, "unexpected.csproj"), "<Project />");
  assert.throws(() => auditLicences(root), /New build system/u);
});
