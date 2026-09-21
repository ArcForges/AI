// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gitEnvironment } from "./provenance.mjs";
const root = path.resolve(import.meta.dirname, "..");

export const axes = [
  "AppVersion",
  "ContractSet",
  "CapabilityVersion",
  "NativeFormatVersion",
  "StorageSchemaVersion",
  "NativeAbiVersion",
  "PolicySchemaVersion",
  "ExtensionProtocolVersion",
  "PackageVersion",
];
const kinds = [
  "release",
  "contracts",
  "declarations",
  "declarations",
  "migrations",
  "native-abi",
  "declarations",
  "declarations",
  "packages",
];
function object(value) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  return value;
}
function string(value) {
  assert.equal(typeof value, "string");
  return value;
}
function array(value) {
  assert(Array.isArray(value));
  return value;
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveAxes(catalog, read) {
  const document = object(catalog);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.owner, "AI");
  const definitions = object(document.axes);
  assert.deepEqual(Object.keys(definitions).sort(), [...axes].sort());
  const result = {};
  for (const [index, name] of axes.entries()) {
    const definition = object(definitions[name]);
    const kind = string(definition.kind);
    assert.equal(kind, kinds[index]);
    if (definition.absence !== undefined) {
      assert(
        Object.keys(definition).every((key) =>
          ["kind", "absence", "reason", "producer"].includes(key),
        ),
      );
      assert(["not-produced", "not-applicable"].includes(string(definition.absence)));
      assert(string(definition.reason).trim());
      if (definition.absence === "not-produced") assert(string(definition.producer).trim());
      result[name] = {
        status: definition.absence,
        reason: definition.reason,
        ...(definition.producer === undefined ? {} : { producer: definition.producer }),
      };
      continue;
    }
    assert(Object.keys(definition).every((key) => ["kind", "sources"].includes(key)));
    const values = new Map();
    for (const item of array(definition.sources)) {
      const sourcePath = string(item);
      assert(
        !/[\\:]/u.test(sourcePath) &&
          sourcePath.split("/").every((part) => part && part !== "." && part !== ".."),
      );
      const content = read(sourcePath).replaceAll("\r\n", "\n");
      const source = { path: sourcePath, sha256: digest(content) };
      const add = (subject, version, descriptorSha256) => {
        assert(subject.trim() && /^[0-9]+(?:\.[0-9]+)*(?:[-+][A-Za-z0-9.-]+)?$/u.test(version));
        assert(!values.has(subject), "Duplicate version subject");
        values.set(subject, {
          subject,
          version,
          source,
          ...(descriptorSha256 ? { descriptorSha256 } : {}),
        });
      };
      if (kind === "native-abi") {
        const major = /#define\s+ARC_ABI_MAJOR\s+(\d+)/u.exec(content)?.[1];
        const minor = /#define\s+ARC_ABI_MINOR\s+(\d+)/u.exec(content)?.[1];
        assert(major && minor);
        add(sourcePath, `${major}.${minor}`);
        continue;
      }
      const input = object(JSON.parse(content));
      if (kind === "contracts") {
        const schema = /^([a-zA-Z0-9_.]+)\.v([1-9][0-9]*)$/u.exec(string(input.schema));
        assert(schema?.[1] && schema[2]);
        assert.match(string(input.descriptorSha256), /^[a-f0-9]{64}$/u);
        assert.equal(input.dirty, false);
        add(schema[1], schema[2], string(input.descriptorSha256));
      } else if (kind === "packages") {
        if (input.lockfileVersion !== undefined) {
          for (const [name, value] of Object.entries(object(input.packages)))
            if (name) add(`pkg:npm/${name}`, string(object(value).version));
        } else {
          for (const [framework, dependencies] of Object.entries(object(input.dependencies)))
            for (const [name, value] of Object.entries(object(dependencies))) {
              const dependency = object(value);
              if (dependency.type !== "Project")
                add(`pkg:nuget/${name}?target=${framework}`, string(dependency.resolved));
            }
        }
      } else {
        const declarations = array(input[kind === "migrations" ? "migrations" : "versions"]);
        for (const value of kind === "migrations" ? declarations.slice(-1) : declarations) {
          const declaration = object(value);
          add(string(declaration.subject), string(declaration.version));
        }
      }
    }
    assert(kind === "packages" || values.size > 0);
    result[name] = {
      status: "present",
      values: [...values.keys()].sort().map((key) => values.get(key)),
    };
  }
  return result;
}

export function sourceBuild(commit, epoch, dirty, env) {
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert(Number.isSafeInteger(epoch) && epoch > 0);
  const ci = env.GITHUB_ACTIONS === "true";
  const run = ci ? env.GITHUB_RUN_ID : null;
  const attempt = ci ? Number(env.GITHUB_RUN_ATTEMPT) : null;
  if (ci) {
    assert.equal(dirty, false);
    assert.equal(env.GITHUB_SHA, commit);
    assert.equal(env.GITHUB_REPOSITORY, "ArcForges/AI");
    assert.match(run ?? "", /^[1-9][0-9]*$/u);
    assert(Number.isSafeInteger(attempt) && attempt !== null && attempt > 0);
  }
  return {
    sourceCommit: commit,
    dirty,
    kind: ci ? "ci" : "local",
    buildId: ci ? `${run}.${attempt}` : `local.${commit}`,
    runId: run,
    runAttempt: attempt,
    pipelineRun: ci ? `https://github.com/ArcForges/AI/actions/runs/${run}` : null,
    sourceDateEpoch: epoch,
  };
}

export function candidateEnvironment(version, environment) {
  const producer = { ...environment };
  if (producer.GITHUB_ACTIONS === "true") {
    const release = /^0\.1\.0-ci\.([1-9][0-9]*)\.([1-9][0-9]*)$/u.exec(version);
    assert(release?.[1] && release[2]);
    assert.equal(release[1], producer.GITHUB_RUN_NUMBER);
    assert(
      Number(release[2]) <= Number(producer.GITHUB_RUN_ATTEMPT),
      "Candidate is from a future attempt",
    );
    producer.GITHUB_RUN_ATTEMPT = release[2];
  }
  return producer;
}

export function expectedIdentity(version) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      env: gitEnvironment(),
    }).trim();
  const commit = git("rev-parse", "HEAD");
  const producer = candidateEnvironment(version, process.env);
  const build = sourceBuild(
    commit,
    Number(git("show", "-s", "--format=%ct", commit)),
    git("status", "--porcelain").length > 0,
    producer,
  );
  const read = (name) => {
    if (name === "release/app.json")
      return JSON.stringify({ versions: [{ subject: "AI", version }] });
    if (name === "packages/contracts/source.json")
      return readFileSync(path.join(root, "node_modules/@arcforges/proto/source.json"), "utf8");
    return readFileSync(path.join(root, name), "utf8");
  };
  // The consumed producer receipt must match the independently pinned npm package.
  const contracts = object(JSON.parse(read("packages/contracts/source.json")));
  const pinned = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies[
    "@arcforges/proto"
  ];
  assert.equal(contracts.version, pinned);
  return {
    schema: "arcforges.build-identity.v1",
    owner: "AI",
    artifact: { id: "AI", version },
    build,
    axes: resolveAxes(JSON.parse(read("eng/version-sources.json")), read),
  };
}

export function verifyIdentity(actual, version) {
  assert.deepEqual(
    actual,
    expectedIdentity(version),
    "Built identity differs from independent source/run/version inputs",
  );
}
export function verifyHealthIdentity(health, identity) {
  const actual = object(health);
  assert.deepEqual(actual.build, identity.build, "Running compiled build identity differs");
  assert.deepEqual(actual.artifact, identity.artifact, "Running application release differs");
}

export function runtimeIdentity(identity) {
  return {
    artifact: identity.artifact,
    build: identity.build,
    reportSha256: digest(JSON.stringify(identity)),
  };
}
