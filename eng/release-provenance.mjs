// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  auditProvenance,
  digest,
  hash,
  inventoryPath,
  object,
  parseDocument,
  readOwned,
  relative,
  store,
  text,
  validateRecord,
} from "./provenance.mjs";

const read = (owner, file) => object(parseDocument(readOwned(owner, file)));
const normalized = (owner, file) =>
  Buffer.from(
    new TextDecoder("utf-8", { fatal: true })
      .decode(readOwned(owner, file))
      .replaceAll("\r\n", "\n"),
  );
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const equal = (actual, expected, message) => assert(isDeepStrictEqual(actual, expected), message);

export function releaseProfile(owner) {
  const inventory = read(owner, inventoryPath);
  assert(Array.isArray(inventory.artifacts) && inventory.artifacts.length === 1);
  const record = validateRecord(read(owner, `${store}${text(inventory.artifacts[0])}.json`));
  assert.equal(record.artifactTargets.length, 1);
  const target = object(record.artifactTargets[0]);
  assert.equal(target.project, "package.json");
  assert.equal(target.package, "@arcforges/ai");
  assert.equal(target.kind, "worker-bundle");
  const profilePath = relative(target.profile);
  const profileHash = digest(target.sha256);
  assert.equal(hash(normalized(owner, profilePath)), profileHash, "Changed artifact profile");
  const profile = object(
    read(owner, profilePath),
    "schemaVersion id ownerCommit lockSha256 configurationSha256 worker packages fixedLegal authoredLegal contracts sbom",
  );
  assert.equal(profile.schemaVersion, 1);
  assert.match(text(profile.id), /^ai-worker-r[1-9][0-9]*$/u);
  digest(profile.ownerCommit, 40);
  assert.equal(
    hash(normalized(owner, "package-lock.json")),
    digest(profile.lockSha256),
    "Changed dependency lock",
  );
  assert.equal(
    hash(normalized(owner, "wrangler.json")),
    digest(profile.configurationSha256),
    "Changed Worker configuration",
  );
  const worker = object(
    profile.worker,
    "sha256 inputs outputInputs exports externalImports sourceMap readmePrefix",
  );
  digest(worker.sha256);
  const inputs = object(worker.inputs);
  assert(Object.keys(inputs).length > 0);
  for (const [file, expected] of Object.entries(inputs))
    assert.equal(
      hash(normalized(owner, relative(file))),
      digest(expected),
      `Changed bundler input: ${file}`,
    );
  const lock = object(read(owner, "package-lock.json").packages);
  for (const [directory, value] of Object.entries(object(profile.packages))) {
    relative(directory);
    const expected = object(value, "version integrity");
    const installed = read(owner, `${directory}/package.json`);
    assert.equal(installed.version, expected.version, `Changed installed package: ${directory}`);
    assert.equal(object(lock[directory]).version, expected.version);
    assert.equal(object(lock[directory]).integrity, expected.integrity);
  }
  equal(
    profile.authoredLegal,
    ["THIRD_PARTY_NOTICES.md", "eng/provenance/NOTICE.txt"],
    "Changed authored notice locations",
  );
  for (const [destination, value] of Object.entries(object(profile.fixedLegal))) {
    relative(destination);
    const item = object(value);
    relative(item.source);
    digest(item.sha256);
    equal(
      Object.keys(item).sort(),
      (item.transform ? ["source", "sha256", "transform"] : ["source", "sha256"]).sort(),
      "Unknown legal transformation",
    );
    if (item.transform) assert.equal(item.transform, "initial-comment-header");
  }
  return { profile, profilePath, profileHash, record: record.id };
}

function legalBytes(owner, entry) {
  let bytes = normalized(owner, entry.source);
  if (entry.transform) {
    const header = [];
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.startsWith("//")) break;
      header.push(line);
    }
    bytes = Buffer.from(`${header.join("\n")}\n`);
  }
  assert.equal(hash(bytes), entry.sha256, `Changed legal source: ${entry.source}`);
  return bytes;
}

function filesUnder(directory) {
  const files = [];
  const visit = (relativeDirectory) => {
    for (const name of readdirSync(path.join(directory, relativeDirectory))) {
      const file = path.posix.join(relativeDirectory, name);
      const stat = lstatSync(path.join(directory, file));
      assert(!stat.isSymbolicLink(), "Linked candidate member");
      if (stat.isDirectory()) visit(file);
      else {
        assert(stat.isFile(), "Non-regular candidate member");
        files.push(file);
      }
    }
  };
  visit("");
  return files.sort();
}

export function verifyWorker(owner, directory) {
  const { profile } = releaseProfile(owner);
  const expected = profile.worker;
  const worker = readOwned(directory, "worker/index.js");
  assert.equal(hash(worker), expected.sha256, "Changed or unclassified Worker bytes");
  const metadata = object(read(directory, "worker-meta.json"), "inputs outputs");
  equal(
    Object.keys(object(metadata.inputs)).sort(),
    Object.keys(expected.inputs).sort(),
    "Changed parsed input closure",
  );
  const outputs = object(metadata.outputs);
  const names = Object.keys(outputs).sort();
  const script = names.find((name) => name.endsWith("/index.js"));
  assert(script);
  relative(script);
  equal(names, [script, `${script}.map`].sort(), "Unclassified generated resource");
  const output = object(outputs[script]);
  assert.equal(output.entryPoint, "src/index.ts");
  assert.equal(output.bytes, worker.length);
  equal(
    Object.keys(object(output.inputs)).sort(),
    expected.outputInputs,
    "Changed emitted input closure",
  );
  equal([...output.exports].sort(), expected.exports, "Changed Worker exports");
  const imports = output.imports.map((item) => {
    const entry = object(item, "path kind external");
    assert.equal(entry.kind, "import-statement");
    assert.equal(entry.external, true);
    return text(entry.path);
  });
  equal(imports.sort(), expected.externalImports, "Changed runtime imports");
  const sourceMap = object(
    read(directory, "worker/index.js.map"),
    "version sources sourceRoot sourcesContent mappings names",
  );
  const mapProfile = object(
    expected.sourceMap,
    "version sourceRootMode sources mappingsSha256 names",
  );
  equal(sourceMap.version, mapProfile.version, "Changed source map version");
  assert.equal(mapProfile.sourceRootMode, "output-directory");
  equal(sourceMap.sourceRoot, path.posix.dirname(script), "Changed source map root");
  equal(sourceMap.names, mapProfile.names, "Changed source map names");
  assert.equal(
    hash(Buffer.from(text(sourceMap.mappings))),
    mapProfile.mappingsSha256,
    "Changed source map mappings",
  );
  assert(Array.isArray(sourceMap.sources) && Array.isArray(sourceMap.sourcesContent));
  const sourceNames = sourceMap.sources.map((name) =>
    relative(text(name).replace(/^(?:\.\.\/)+/u, "")),
  );
  equal(sourceNames, mapProfile.sources, "Changed source map source membership");
  equal(
    sourceMap.sources,
    sourceNames.map((name) => path.posix.relative(path.posix.dirname(script), name)),
    "Changed source map path interpretation",
  );
  assert.equal(sourceNames.length, sourceMap.sourcesContent.length);
  for (let index = 0; index < sourceNames.length; index++)
    assert.equal(
      hash(Buffer.from(text(sourceMap.sourcesContent[index]))),
      expected.inputs[sourceNames[index]],
      "Changed embedded source body",
    );
  assert.equal(
    object(outputs[`${script}.map`]).bytes,
    readOwned(directory, "worker/index.js.map").length,
  );
  const readme = readOwned(directory, "worker/README.md").toString("utf8");
  assert(
    readme.startsWith(expected.readmePrefix) && readme.endsWith("."),
    "Changed generated README template",
  );
  const timestamp = readme.slice(expected.readmePrefix.length, -1);
  assert.equal(new Date(timestamp).toISOString(), timestamp, "Invalid generated README timestamp");
  return {
    sha256: hash(worker),
    bytes: worker.length,
    parsedInputs: Object.keys(expected.inputs).length,
    emittedInputs: expected.outputInputs.length,
    sourceMapBodies: sourceNames.length,
  };
}

function sourceReceipt(owner, manifest, identity) {
  const audit = auditProvenance(owner);
  assert.equal(manifest.sourceCommit, audit.sourceCommit, "Wrong candidate source revision");
  assert.equal(manifest.sourceDirty, audit.dirty, "Wrong candidate source state");
  return {
    schemaVersion: 1,
    repository: "https://github.com/ArcForges/AI",
    sourceCommit: audit.sourceCommit,
    sourceDirty: audit.dirty,
    profile: { path: identity.profilePath, sha256: identity.profileHash },
    artifactRecord: identity.record,
    noticeSha256: audit.noticeSha256,
    records: Object.fromEntries(
      audit.activeRecords.map((id) => [id, read(owner, `${store}${id}.json`)]),
    ),
  };
}

function verifyContents(owner, directory, identity, manifest) {
  const profile = identity.profile;
  const expected = [
    "candidate.json",
    "provenance.json",
    "worker/index.js",
    "worker/index.js.map",
    "worker/README.md",
    "worker-meta.json",
    "wrangler.json",
    "package-lock.json",
    "contracts-source.json",
    "sbom.cdx.json",
    ...Object.keys(profile.fixedLegal),
    ...profile.authoredLegal,
  ].sort();
  equal(
    filesUnder(directory).filter((file) => file !== "candidate.json" && file !== "provenance.json"),
    expected.filter((file) => file !== "candidate.json" && file !== "provenance.json"),
    "Unclassified or missing candidate member",
  );
  const worker = verifyWorker(owner, directory);
  for (const [destination, value] of Object.entries(profile.fixedLegal))
    assert(
      readOwned(directory, destination).equals(legalBytes(owner, value)),
      `Changed distributed legal text: ${destination}`,
    );
  for (const file of profile.authoredLegal)
    assert(
      readOwned(directory, file).equals(normalized(owner, file)),
      `Changed authored notice: ${file}`,
    );
  assert.equal(
    hash(normalized(directory, "package-lock.json")),
    profile.lockSha256,
    "Changed distributed lock",
  );
  equal(
    read(directory, "contracts-source.json"),
    profile.contracts,
    "Changed Contracts source identity",
  );
  equal(
    read(owner, "node_modules/@arcforges/proto/source.json"),
    profile.contracts,
    "Changed installed Contracts identity",
  );
  const configuration = read(owner, "wrangler.json");
  delete configuration.$schema;
  configuration.main = "worker/index.js";
  configuration.no_bundle = true;
  configuration.vars = { BUILD_VERSION: manifest.version, SOURCE_COMMIT: manifest.sourceCommit };
  equal(
    read(directory, "wrangler.json"),
    configuration,
    "Changed candidate deployment configuration",
  );
  const sbom = read(directory, "sbom.cdx.json");
  assert.equal(sbom.bomFormat, profile.sbom.bomFormat);
  assert.equal(sbom.specVersion, profile.sbom.specVersion);
  const root = object(object(sbom.metadata).component);
  assert.equal(root["bom-ref"], profile.sbom.rootRef);
  assert.equal(root.purl, profile.sbom.rootPurl);
  assert.equal(root.name, profile.sbom.rootName);
  assert.equal(root.version, profile.sbom.rootRef.slice(profile.sbom.rootRef.lastIndexOf("@") + 1));
  equal(root.licenses, [{ license: { id: "AGPL-3.0-only" } }], "Changed root SBOM licence");
  assert(Array.isArray(sbom.components));
  const keys = ["bom-ref", "name", "version", "purl", "hashes", "licenses"];
  equal(
    sbom.components
      .map((entry) => Object.fromEntries(keys.map((key) => [key, entry[key]])))
      .sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
    [...profile.sbom.components].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
    "Changed runtime SBOM component closure",
  );
  equal(
    sbom.dependencies
      .map((entry) => ({ ref: entry.ref, dependsOn: [...entry.dependsOn].sort() }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    profile.sbom.dependencies
      .map((entry) => ({ ref: entry.ref, dependsOn: [...entry.dependsOn].sort() }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
    "Changed runtime SBOM dependency closure",
  );
  return {
    worker,
    members: Object.fromEntries(
      expected
        .filter((file) => !["candidate.json", "provenance.json"].includes(file))
        .map((file) => [file, hash(readOwned(directory, file))]),
    ),
  };
}

export function stageProvenance(owner, directory, manifest) {
  const identity = releaseProfile(owner);
  for (const [destination, entry] of Object.entries(identity.profile.fixedLegal)) {
    const file = path.join(directory, destination);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, legalBytes(owner, entry));
  }
  for (const name of identity.profile.authoredLegal) {
    const file = path.join(directory, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, normalized(owner, name));
  }
  const source = sourceReceipt(owner, manifest, identity);
  const result = { ...source, ...verifyContents(owner, directory, identity, manifest) };
  writeFileSync(path.join(directory, "provenance.json"), json(result));
  return result;
}

export function verifyProvenance(owner, directory, manifest) {
  const identity = releaseProfile(owner);
  const expected = {
    ...sourceReceipt(owner, manifest, identity),
    ...verifyContents(owner, directory, identity, manifest),
  };
  equal(read(directory, "provenance.json"), expected, "Changed distributed source provenance");
  return expected;
}
