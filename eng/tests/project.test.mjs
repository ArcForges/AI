// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256, verifyCandidate, versionFromRun, writeJson } from "../project.mjs";

test("automatic versions include both run number and attempt", () => {
  assert.equal(versionFromRun("31", "2"), "0.1.0-ci.31.2");
  for (const bad of ["0", "-1", "1.2", "", "01"]) assert.throws(() => versionFromRun(bad, "1"));
});

test("candidate validation rejects tampering and another source commit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcforges-ai-candidate-test-"));
  const commit = "a".repeat(40);
  const config = {
    name: "arcforges-ai-hello",
    main: "worker/index.js",
    no_bundle: true,
    workers_dev: false,
    preview_urls: false,
    vars: { SOURCE_COMMIT: commit, BUILD_VERSION: "0.1.0-ci.1.1" },
    ai: { binding: "AI" },
    version_metadata: { binding: "CF_VERSION" },
    workflows: [
      { name: "arcforges-ai-hello", binding: "HELLO_AGENT", class_name: "HelloAgentWorkflow" },
    ],
  };
  try {
    fs.mkdirSync(path.join(directory, "worker"));
    fs.writeFileSync(path.join(directory, "worker/index.js"), "// test fixture\n");
    writeJson(path.join(directory, "wrangler.json"), config);
    writeJson(path.join(directory, "candidate.json"), {
      schemaVersion: 1,
      sourceCommit: commit,
      sourceDirty: false,
      version: config.vars.BUILD_VERSION,
      files: Object.fromEntries(
        ["worker/index.js", "wrangler.json"].map((file) => [
          file,
          sha256(fs.readFileSync(path.join(directory, file))),
        ]),
      ),
    });
    verifyCandidate(directory, commit);
    assert.throws(() => verifyCandidate(directory, "b".repeat(40)), /source mismatch/u);
    fs.appendFileSync(path.join(directory, "wrangler.json"), " ");
    assert.throws(() => verifyCandidate(directory, commit), /Candidate changed/u);
  } finally {
    for (const file of ["wrangler.json", "candidate.json", "worker/index.js"])
      fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(path.join(directory, "worker"));
    fs.rmdirSync(directory);
  }
});
