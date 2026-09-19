// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CANDIDATE, readJson, verifyCandidate, versionFromRun } from "../project.mjs";

test("automatic versions include both run number and attempt", () => {
  assert.equal(versionFromRun("31", "2"), "0.1.0-ci.31.2");
  for (const bad of ["0", "-1", "1.2", "", "01"]) assert.throws(() => versionFromRun(bad, "1"));
});

test("candidate validation rejects tampering and another source commit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcforges-ai-candidate-test-"));
  const commit = readJson(path.join(CANDIDATE, "candidate.json")).sourceCommit;
  try {
    // pretest:tooling builds the actual locked Wrangler output and complete legal candidate.
    fs.cpSync(CANDIDATE, directory, { recursive: true });
    verifyCandidate(directory, commit);
    assert.throws(() => verifyCandidate(directory, "b".repeat(40)), /source mismatch/u);
    fs.appendFileSync(path.join(directory, "wrangler.json"), " ");
    assert.throws(() => verifyCandidate(directory, commit), /Candidate changed/u);
  } finally {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert(path.basename(directory).startsWith("arcforges-ai-candidate-test-"));
    fs.rmSync(directory, { recursive: true });
  }
});
