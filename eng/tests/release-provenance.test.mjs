// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CANDIDATE,
  filesUnder,
  readJson,
  sha256,
  verifyCandidate,
  writeJson,
} from "../project.mjs";

function scenario(name, change, expected) {
  test(name, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ai-release-provenance-"));
    try {
      cpSync(CANDIDATE, directory, { recursive: true });
      const read = (name) => readJson(path.join(directory, name));
      const write = (name, value) => writeJson(path.join(directory, name), value);
      change({ directory, read, write });
      // An attacker-controlled outer manifest is not an independent provenance oracle.
      const manifest = read("candidate.json");
      manifest.files = Object.fromEntries(
        filesUnder(directory)
          .filter((file) => path.basename(file) !== "candidate.json")
          .map((file) => [
            path.relative(directory, file).split(path.sep).join("/"),
            sha256(readFileSync(file)),
          ]),
      );
      write("candidate.json", manifest);
      assert.throws(() => verifyCandidate(directory), expected);
    } finally {
      assert.equal(path.dirname(directory), os.tmpdir());
      assert(path.basename(directory).startsWith("ai-release-provenance-"));
      rmSync(directory, { recursive: true });
    }
  });
}

test("actual locked candidate retains the deduplicated protobuf runtime and all packaged provenance", () => {
  const manifest = verifyCandidate();
  const receipt = readJson(path.join(CANDIDATE, "provenance.json"));
  assert.equal(receipt.sourceCommit, manifest.sourceCommit);
  assert.equal(
    receipt.worker.sha256,
    "8c3c32fb0d7e37238eb52c882ca74f80e3d7be70447a0fed00e426a63f607e93",
  );
  assert.equal(receipt.worker.parsedInputs, 73);
  assert.equal(receipt.worker.emittedInputs, 33);
  assert.equal(receipt.worker.sourceMapBodies, 31);
  const sbom = readJson(path.join(CANDIDATE, "sbom.cdx.json"));
  assert.deepEqual(
    sbom.components
      .filter((entry) => entry.name === "@bufbuild/protobuf")
      .map((entry) => entry.version)
      .sort(),
    ["2.15.0"],
  );
  assert.equal(sbom.metadata.component.name, "@arcforges/ai");
});

scenario(
  "reject modified Worker despite a recomputed manifest",
  ({ directory }) => {
    const file = path.join(directory, "worker/index.js");
    writeFileSync(
      file,
      Buffer.concat([readFileSync(file), Buffer.from("\nexport const extra = true;\n")]),
    );
  },
  /Changed or unclassified Worker bytes/u,
);

scenario(
  "reject new parsed inputs",
  ({ read, write }) => {
    const meta = read("worker-meta.json");
    meta.inputs["node_modules/unreviewed/index.js"] = {};
    write("worker-meta.json", meta);
  },
  /Changed parsed input closure/u,
);

scenario(
  "reject changed emitted inputs",
  ({ read, write }) => {
    const meta = read("worker-meta.json");
    const script = Object.keys(meta.outputs).find((name) => name.endsWith("/index.js"));
    meta.outputs[script].inputs["unreviewed.js"] = { bytesInOutput: 1 };
    write("worker-meta.json", meta);
  },
  /Changed emitted input closure/u,
);

scenario(
  "reject generated resources absent from the reviewed profile",
  ({ read, write }) => {
    const meta = read("worker-meta.json");
    meta.outputs["artifacts/candidate/worker/extra.wasm"] = {};
    write("worker-meta.json", meta);
  },
  /Unclassified generated resource/u,
);

scenario(
  "reject added packaged resources even with an updated manifest",
  ({ directory }) => {
    writeFileSync(path.join(directory, "worker/unreviewed.js"), "// extra\n");
  },
  /Unclassified or missing candidate member/u,
);

scenario(
  "reject an extra runtime import",
  ({ read, write }) => {
    const meta = read("worker-meta.json");
    const script = Object.keys(meta.outputs).find((name) => name.endsWith("/index.js"));
    meta.outputs[script].imports.push({
      path: "unreviewed:runtime",
      kind: "import-statement",
      external: true,
    });
    write("worker-meta.json", meta);
  },
  /Changed runtime imports/u,
);

scenario(
  "reject changed embedded source-map bodies",
  ({ read, write }) => {
    const map = read("worker/index.js.map");
    map.sourcesContent[0] = `x${map.sourcesContent[0].slice(1)}`;
    write("worker/index.js.map", map);
  },
  /Changed embedded source body/u,
);

scenario(
  "reject changed source-map path interpretation",
  ({ read, write }) => {
    const map = read("worker/index.js.map");
    map.sources[0] = `../${map.sources[0]}`;
    write("worker/index.js.map", map);
  },
  /Changed source map path interpretation/u,
);

scenario(
  "reject a source-map root outside the actual output directory",
  ({ read, write }) => {
    const map = read("worker/index.js.map");
    map.sourceRoot = "C:/another-checkout/artifacts/candidate/worker";
    write("worker/index.js.map", map);
  },
  /Changed source map root/u,
);

scenario(
  "reject omitted full MIT terms",
  ({ directory }) => {
    rmSync(path.join(directory, "third-party/Esbuild.LICENSE.txt"));
  },
  /Unclassified or missing candidate member/u,
);

scenario(
  "reject changed Buf copyright and terms",
  ({ directory }) => {
    writeFileSync(path.join(directory, "third-party/Buf.LICENSE.txt"), "Apache-2.0\n");
  },
  /Changed distributed legal text/u,
);

scenario(
  "reject an altered generated README template",
  ({ directory }) => {
    writeFileSync(path.join(directory, "worker/README.md"), "unreviewed material");
  },
  /Changed generated README template/u,
);

scenario(
  "reject omission of the protobuf runtime from the SBOM",
  ({ read, write }) => {
    const sbom = read("sbom.cdx.json");
    sbom.components = sbom.components.filter((entry) => entry.name !== "@bufbuild/protobuf");
    write("sbom.cdx.json", sbom);
  },
  /Changed runtime SBOM component closure/u,
);

scenario(
  "reject dependency edge changes",
  ({ read, write }) => {
    const sbom = read("sbom.cdx.json");
    sbom.dependencies[0].dependsOn = [];
    write("sbom.cdx.json", sbom);
  },
  /Changed runtime SBOM dependency closure/u,
);

scenario(
  "reject stale Contracts provenance",
  ({ read, write }) => {
    const source = read("contracts-source.json");
    source.commit = "a".repeat(40);
    write("contracts-source.json", source);
  },
  /Changed Contracts source identity/u,
);

scenario(
  "reject altered source receipts",
  ({ read, write }) => {
    const receipt = read("provenance.json");
    receipt.sourceCommit = "a".repeat(40);
    write("provenance.json", receipt);
  },
  /Changed distributed source provenance/u,
);

scenario(
  "reject configuration changes outside the promotion transformation",
  ({ read, write }) => {
    const config = read("wrangler.json");
    config.observability.enabled = false;
    write("wrangler.json", config);
  },
  /Changed candidate deployment configuration/u,
);

scenario(
  "reject report tampering even after resealing the candidate",
  ({ read, write }) => {
    const identity = read("build-identity.json");
    identity.build.buildId = "another-run";
    write("build-identity.json", identity);
  },
  /Built identity differs/u,
);
scenario(
  "reject a substituted runtime binding even after resealing",
  ({ read, write }) => {
    const config = read("wrangler.json");
    const identity = JSON.parse(config.vars.BUILD_IDENTITY);
    identity.reportSha256 = "0".repeat(64);
    config.vars.BUILD_IDENTITY = JSON.stringify(identity);
    write("wrangler.json", config);
  },
  /Expected values to be strictly deep-equal/u,
);
