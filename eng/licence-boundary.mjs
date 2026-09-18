// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const firstParty = new Set([
  "@arcforges/proto",
  "@arcforges/api-client",
  "@arcforges/ai-internal",
  "@arcforges/contract-fixtures",
  "@arcforges/ai",
  "@arcforges/cloud-workspace",
  "@arcforges/web-workspace",
  "@arcforges/web-site",
  "@arcforges/web-ui",
]);

export function auditLicences(root) {
  root = realpathSync(root);
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  const files = [
    ...new Set(
      git("ls-files", "-z", "--cached", "--others", "--exclude-standard")
        .split("\0")
        .filter(Boolean),
    ),
  ];
  const read = (name) => {
    const absolute = path.resolve(root, name);
    assert(absolute.startsWith(root + path.sep), `Escaped licence input: ${name}`);
    assert(realpathSync(absolute).startsWith(root + path.sep), `Linked licence input: ${name}`);
    for (let current = absolute; current !== root; current = path.dirname(current))
      assert(!lstatSync(current).isSymbolicLink(), `Linked licence input: ${name}`);
    return JSON.parse(readFileSync(absolute, "utf8"));
  };
  const policy = read("eng/policy/licence-boundary.json");
  assert.deepEqual(Object.keys(policy).sort(), [
    "licenceBoundary",
    "projects",
    "repository",
    "schemaVersion",
    "spdxLicense",
  ]);
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.repository, "AI");
  assert.equal(policy.spdxLicense, "AGPL-3.0-only");
  assert.equal(policy.licenceBoundary, "AGPL");
  const manifests = files.filter((file) => path.basename(file) === "package.json").sort();
  assert(
    !files.some((file) =>
      /\.(?:csproj|fsproj|vbproj|vcxproj|esproj)$|(?:^|\/)(?:build\.gradle(?:\.kts)?|CMakeLists\.txt)$/u.test(
        file,
      ),
    ),
    "New build system requires licence review and an evaluated verifier.",
  );
  for (const row of policy.projects) {
    assert.deepEqual(Object.keys(row).sort(), ["kind", "path"]);
    assert.equal(row.kind, "npm");
  }
  assert(manifests.length > 0);
  assert.deepEqual(
    policy.projects.map((row) => row.path).sort(),
    manifests,
    "Project licence inventory drift.",
  );
  const names = new Map(manifests.map((file) => [read(file).name, file]));
  assert.equal(names.size, manifests.length, "Duplicate npm project identity.");
  const checkPackage = (name) => {
    if (name.toLowerCase().startsWith("@arcforges/") && !names.has(name))
      assert(firstParty.has(name), `Unknown first-party package owner: ${name}`);
  };
  const projects = manifests.map((file) => {
    const manifest = read(file);
    assert.equal(manifest.license, "AGPL-3.0-only", `Incorrect SPDX: ${file}`);
    assert.deepEqual(
      manifest.arcforges,
      { licenceBoundary: "AGPL" },
      `Incorrect boundary: ${file}`,
    );
    const dependencies = [];
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        assert(
          !/^(?:file:|link:|git\+|\.\.?\/)/u.test(version),
          `Unpublished npm reference: ${file}: ${name}`,
        );
        checkPackage(name);
        if (version.startsWith("npm:")) {
          const alias = version.slice(4);
          const end = alias.indexOf("@", 1);
          checkPackage(end < 0 ? alias : alias.slice(0, end));
        }
        dependencies.push({ name, version, project: names.get(name) ?? null });
      }
    return {
      path: file,
      kind: "npm",
      spdxLicense: manifest.license,
      licenceBoundary: manifest.arcforges.licenceBoundary,
      dependencies,
    };
  });
  for (const file of files.filter((file) => path.basename(file) === "package-lock.json"))
    for (const [name, entry] of Object.entries(read(file).packages))
      checkPackage(entry.name ?? name.split("node_modules/").at(-1));
  return {
    result: "passed",
    repository: "AI",
    commit: git("rev-parse", "HEAD"),
    dirty: Boolean(git("status", "--porcelain")),
    projects,
    findings: [],
    evidenceClass: "npm-project-inventory-and-locked-first-party-reference-audit",
  };
}
