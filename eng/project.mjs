// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLicences } from "./licence-boundary.mjs";
import { auditProvenance, gitEnvironment, parseDocument } from "./provenance.mjs";
import { stageProvenance, verifyProvenance } from "./release-provenance.mjs";
import { expectedIdentity, verifyIdentity, runtimeIdentity } from "./build-identity.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CANDIDATE = path.resolve(ROOT, process.env.CANDIDATE_DIR ?? "artifacts/candidate");
const WRANGLER = path.join(ROOT, "node_modules/wrangler/bin/wrangler.js");

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
    ...(command === "git" ? { env: gitEnvironment() } : {}),
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed (${result.status}): ${result.stderr ?? ""}${result.stdout ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

export function wrangler(args, options) {
  return run(process.execPath, [WRANGLER, ...args], options);
}

export function readJson(file) {
  return parseDocument(fs.readFileSync(file));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function filesUnder(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((item) => {
      const file = path.join(directory, item.name);
      assert(!item.isSymbolicLink(), "Artifacts must not contain symbolic links.");
      return item.isDirectory() ? filesUnder(file) : [file];
    })
    .sort();
}

export function versionFromRun(number, attempt) {
  assert(/^[1-9]\d*$/u.test(number) && /^[1-9]\d*$/u.test(attempt), "Invalid CI run identity.");
  return `0.1.0-ci.${number}.${attempt}`;
}

function sourceCommit() {
  const commit = process.env.GITHUB_SHA ?? run("git", ["rev-parse", "HEAD"]).trim();
  assert(/^[0-9a-f]{40}$/u.test(commit), "Expected a full source commit.");
  return commit;
}

function resetGeneratedCandidate() {
  const artifactRoot = path.resolve(ROOT, "artifacts");
  const relative = path.relative(artifactRoot, CANDIDATE);
  assert(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Candidate must be inside this worktree's artifacts directory.",
  );
  if (fs.existsSync(CANDIDATE)) {
    assert(!fs.lstatSync(CANDIDATE).isSymbolicLink(), "Refusing a linked candidate directory.");
    // This is the resolved, checked, generated output directory, never source.
    fs.rmSync(CANDIDATE, { recursive: true });
  }
  fs.mkdirSync(CANDIDATE, { recursive: true });
}

export function verifyCandidate(directory = CANDIDATE, expectedCommit = process.env.GITHUB_SHA) {
  const manifest = readJson(path.join(directory, "candidate.json"));
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.version, /^0\.1\.0-(?:local|ci\.[1-9]\d*\.[1-9]\d*)$/u);
  assert.equal(
    typeof manifest.sourceDirty,
    "boolean",
    "Candidate must declare source cleanliness.",
  );
  assert(/^[0-9a-f]{40}$/u.test(manifest.sourceCommit));
  if (expectedCommit)
    assert.equal(manifest.sourceCommit, expectedCommit, "Candidate source mismatch.");
  const actual = filesUnder(directory)
    .map((file) => path.relative(directory, file).split(path.sep).join("/"))
    .filter((file) => file !== "candidate.json");
  assert(actual.includes("worker/index.js"), "Candidate bundle entry is missing.");
  assert.deepEqual(
    actual.sort(),
    Object.keys(manifest.files).sort(),
    "Candidate file set changed.",
  );
  for (const file of actual) {
    assert.equal(
      sha256(fs.readFileSync(path.join(directory, file))),
      manifest.files[file],
      `Candidate changed: ${file}`,
    );
  }
  const config = readJson(path.join(directory, "wrangler.json"));
  assert.equal(config.name, "arcforges-ai-hello");
  assert.equal(config.main, "worker/index.js");
  assert.equal(config.no_bundle, true);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert(!config.routes?.length && !config.route, "Demo must not expose a public route.");
  assert.equal(config.vars.SOURCE_COMMIT, manifest.sourceCommit);
  assert.equal(config.vars.BUILD_VERSION, manifest.version);
  assert.equal(config.ai.binding, "AI");
  assert.deepEqual(config.version_metadata, { binding: "CF_VERSION" });
  assert.deepEqual(config.workflows, [
    { name: "arcforges-ai-hello", binding: "HELLO_AGENT", class_name: "HelloAgentWorkflow" },
  ]);
  const identity = readJson(path.join(directory, "build-identity.json"));
  verifyIdentity(identity, manifest.version);
  assert.deepEqual(JSON.parse(config.vars.BUILD_IDENTITY), runtimeIdentity(identity));
  verifyProvenance(ROOT, directory, manifest);
  return manifest;
}

async function build() {
  writeJson(path.join(ROOT, "artifacts/evidence/licence-boundary.json"), auditLicences(ROOT));
  writeJson(path.join(ROOT, "artifacts/evidence/source-provenance.json"), auditProvenance(ROOT));
  resetGeneratedCandidate();
  const version = process.env.GITHUB_RUN_NUMBER
    ? versionFromRun(process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT ?? "1")
    : "0.1.0-local";
  const commit = sourceCommit();
  const sourceDirty =
    run("git", ["status", "--porcelain", "--untracked-files=normal"]).trim().length > 0;
  process.stdout.write(
    wrangler([
      "deploy",
      "--dry-run",
      "--outdir",
      path.relative(ROOT, path.join(CANDIDATE, "worker")).split(path.sep).join("/"),
      "--metafile",
      path.join(CANDIDATE, "worker-meta.json"),
    ]),
  );
  assert(
    fs.existsSync(path.join(CANDIDATE, "worker/index.js")),
    "Wrangler bundle entry is missing.",
  );
  const config = readJson(path.join(ROOT, "wrangler.json"));
  delete config.$schema;
  config.main = "worker/index.js";
  config.no_bundle = true;
  const identity = expectedIdentity(version);
  assert.equal(identity.build.sourceCommit, commit);
  writeJson(path.join(CANDIDATE, "build-identity.json"), identity);
  config.vars = {
    BUILD_VERSION: version,
    SOURCE_COMMIT: commit,
    BUILD_IDENTITY: JSON.stringify(runtimeIdentity(identity)),
  };
  writeJson(path.join(CANDIDATE, "wrangler.json"), config);
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "package-lock.json"]) {
    fs.copyFileSync(path.join(ROOT, file), path.join(CANDIDATE, file));
  }
  fs.mkdirSync(path.join(CANDIDATE, "licenses"));
  fs.copyFileSync(
    path.join(ROOT, "node_modules/@arcforges/proto/LICENSE"),
    path.join(CANDIDATE, "licenses/Apache-2.0.txt"),
  );
  fs.copyFileSync(
    path.join(ROOT, "node_modules/@arcforges/proto/NOTICE"),
    path.join(CANDIDATE, "licenses/Contracts-NOTICE.txt"),
  );
  fs.copyFileSync(
    path.join(ROOT, "node_modules/@arcforges/proto/source.json"),
    path.join(CANDIDATE, "contracts-source.json"),
  );
  // This published runtime embeds its BSD notice in the varint source rather
  // than shipping a separate license file. Preserve the complete header.
  const varint = fs.readFileSync(
    path.join(ROOT, "node_modules/@bufbuild/protobuf/dist/esm/wire/varint.js"),
    "utf8",
  );
  const bsdHeader = varint
    .split(/\r?\n/u)
    .filter(
      (line, index, lines) =>
        line.startsWith("//") &&
        lines.slice(0, index).every((previous) => previous.startsWith("//")),
    )
    .join("\n");
  assert(
    bsdHeader.includes("Copyright 2008 Google") && bsdHeader.includes("THIS SOFTWARE IS PROVIDED"),
    "Review the updated protobuf runtime's license notice before packaging.",
  );
  fs.writeFileSync(path.join(CANDIDATE, "licenses/protobuf-BSD-3-Clause.txt"), `${bsdHeader}\n`);
  const npmCli = process.env.npm_execpath;
  assert(npmCli, "Run the build through npm.");
  const sbom = JSON.parse(
    run(process.execPath, [npmCli, "sbom", "--sbom-format", "cyclonedx", "--omit=dev"]),
  );
  // npm otherwise uses the checkout directory as this private root's display name.
  sbom.metadata.component.name = readJson(path.join(ROOT, "package.json")).name;
  writeJson(path.join(CANDIDATE, "sbom.cdx.json"), sbom);
  const provenance = stageProvenance(ROOT, CANDIDATE, {
    sourceCommit: commit,
    sourceDirty,
    version,
  });
  writeJson(path.join(ROOT, "artifacts/evidence/release-provenance.json"), provenance);
  const files = Object.fromEntries(
    filesUnder(CANDIDATE).map((file) => [
      path.relative(CANDIDATE, file).split(path.sep).join("/"),
      sha256(fs.readFileSync(file)),
    ]),
  );
  writeJson(path.join(CANDIDATE, "candidate.json"), {
    schemaVersion: 1,
    version,
    sourceCommit: commit,
    sourceDirty,
    files,
  });
  verifyCandidate();
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(
    `Verified candidate ${version} from ${commit}${sourceDirty ? " (uncommitted local changes; deployment disabled)" : ""}.`,
  );
}

async function testBundle() {
  const manifest = verifyCandidate();
  const { createTestHarness } = await import("wrangler");
  const config = readJson(path.join(CANDIDATE, "wrangler.json"));
  // The compiled code is unchanged. Only the remote AI binding is absent in this
  // local harness; introspection supplies explicit model-step test fixtures.
  delete config.ai;
  config.main = path.join(CANDIDATE, config.main);
  config.dev = { port: 0 };
  const harness = createTestHarness({ workers: [{ config }] });
  try {
    await harness.listen();
    const worker = harness.getWorker();
    const response = await worker.fetch("/health");
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.sourceCommit, manifest.sourceCommit);
    assert.equal(health.version, manifest.version);
    const expectedBuild = runtimeIdentity(expectedIdentity(manifest.version));
    assert.deepEqual(health.buildIdentity, expectedBuild);
    const bindings = await worker.getEnv();
    const target = {
      workerVersion: bindings.CF_VERSION.id,
      sourceCommit: manifest.sourceCommit,
      buildVersion: manifest.version,
    };
    const rejectedId = randomUUID();
    const rejectedInstance = await worker.introspectWorkflowInstance("HELLO_AGENT", rejectedId);
    let rejection;
    try {
      // No AI binding or mocks: a stale actual inference request must stop at admission.
      await bindings.HELLO_AGENT.create({
        id: rejectedId,
        params: {
          kind: "verified-hello",
          expected: { ...target, workerVersion: randomUUID() },
          hello: { name: "Bundle" },
        },
      });
      await rejectedInstance.waitForStatus("complete");
      rejection = await rejectedInstance.getOutput();
      assert.equal(rejection.kind, "deployment-rejected");
      assert.equal(rejection.modelCalls, 0);
      assert.equal(rejection.sourceCommit, manifest.sourceCommit);
      assert.equal(rejection.buildVersion, manifest.version);
      // Wrangler's local Workflow harness uses a separate Worker identity from
      // getEnv(). Use that observed local identity as the positive test fixture;
      // the next instance must still pass its own real admission step.
      target.workerVersion = rejection.workerVersion;
    } finally {
      await rejectedInstance.dispose();
    }
    const id = randomUUID();
    const instance = await worker.introspectWorkflowInstance("HELLO_AGENT", id);
    try {
      await instance.modify(async (modifier) => {
        await modifier.mockStepResult(
          { name: "request-tool" },
          { params: { name: "Bundle" }, callId: "call_bundle_1" },
        );
        await modifier.mockStepResult({ name: "finish-greeting" }, "Hello, Bundle!");
      });
      await bindings.HELLO_AGENT.create({
        id,
        params: { kind: "verified-hello", expected: target, hello: { name: "Bundle" } },
      });
      await instance.waitForStatus("complete");
      const output = await instance.getOutput();
      assert.equal(output.toolMessage, "Hello, Bundle!");
      assert.equal(output.admission.accepted, true);
      assert.deepEqual(output.admission.actual, { runId: id, ...target });
      assert.equal(output.sourceCommit, manifest.sourceCommit);
      assert.deepEqual(output.buildIdentity, expectedBuild);
      writeJson(path.join(ROOT, "artifacts/bundle-evidence.json"), {
        kind: "local-bundle-mocked-inference",
        ...output,
        rejection,
      });
    } finally {
      await instance.dispose();
    }
  } finally {
    await harness.close();
  }
  console.log("Final bundled Worker and Workflow passed; inference was explicitly mocked.");
}

export function verifyToolchain(nodeVersion, npmVersion) {
  const expectedNode = fs.readFileSync(path.join(ROOT, ".node-version"), "utf8").trim();
  const manifest = readJson(path.join(ROOT, "package.json"));
  assert.equal(nodeVersion, `v${expectedNode}`, "Select the pinned Node version.");
  assert.equal(`npm@${npmVersion}`, manifest.packageManager, "Select the pinned npm version.");
}

function check() {
  assert(process.env.npm_execpath, "Run this check through npm run check.");
  verifyToolchain(
    process.version,
    run(process.execPath, [process.env.npm_execpath, "--version"]).trim(),
  );
  writeJson(path.join(ROOT, "artifacts/evidence/licence-boundary.json"), auditLicences(ROOT));
  writeJson(path.join(ROOT, "artifacts/evidence/source-provenance.json"), auditProvenance(ROOT));
  const listed = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  for (const file of listed) {
    assert(
      !/(^|\/)\.dev\.vars($|\.)|(^|\/)\.env($|\.)|\.(pem|key|p12|pfx)$/u.test(file),
      `Unexpected secret file: ${file}`,
    );
    if (!/\.(ts|mjs|json|md|yml|yaml)$/u.test(file) || file.endsWith("env.generated.d.ts"))
      continue;
    const contents = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert(!contents.includes("\r"), `Expected LF: ${file}`);
    assert(contents.endsWith("\n"), `Missing final newline: ${file}`);
  }
  const root = readJson(path.join(ROOT, "package.json"));
  const lock = readJson(path.join(ROOT, "package-lock.json"));
  for (const name of ["dependencies", "devDependencies"]) {
    assert.deepEqual(root[name], lock.packages[""][name], `Lockfile drift: ${name}`);
    for (const version of Object.values(root[name]))
      assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version), "Pin exact dependency versions.");
  }
  run("git", ["diff", "--check"]);
  console.log("Repository and dependency lock checks passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === "build") await build();
    else if (command === "verify") {
      verifyCandidate();
      console.log("Candidate hashes and source verified.");
    } else if (command === "test-bundle") await testBundle();
    else if (command === "check") check();
    else if (command === "hooks") {
      run("git", ["config", "extensions.worktreeConfig", "true"]);
      run("git", ["config", "--worktree", "core.hooksPath", ".githooks"]);
      console.log("Hooks configured for this worktree.");
    } else throw new Error("Expected check, hooks, build, verify or test-bundle.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Project command failed.");
    process.exitCode = 1;
  }
}
