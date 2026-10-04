// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import {
  type AuditOptions,
  auditArchitecture,
  type Finding,
  type Sources,
} from "../../eng/policy/architecture.ts";
import { auditNamingCandidate, type NamingCandidate } from "../../eng/policy/naming.ts";

const pin = "1.0.0-ci.1.1";
const integrity = `sha512-${"A".repeat(86)}==`;
const lock = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@arcforges/proto": pin, "@bufbuild/protobuf": "2.15.0" } },
      "node_modules/@arcforges/proto": {
        version: pin,
        resolved: `https://registry.npmjs.org/@arcforges/proto/-/proto-${pin}.tgz`,
        integrity,
        license: "Apache-2.0",
      },
      "node_modules/@bufbuild/protobuf": {
        version: "2.15.0",
        license: "(Apache-2.0 AND BSD-3-Clause)",
      },
      "node_modules/vitest": { version: "4.1.11", license: "MIT", dev: true },
      ...extra,
    },
  });
const manifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "@arcforges/ai",
    license: "AGPL-3.0-only",
    arcforges: { licenceBoundary: "AGPL" },
    dependencies: { "@arcforges/proto": pin, "@bufbuild/protobuf": "2.15.0" },
    devDependencies: { vitest: "4.1.11" },
    ...overrides,
  });
const inventory = (projects = ["package.json"]) =>
  JSON.stringify({
    schemaVersion: 1,
    repository: "AI",
    spdxLicense: "AGPL-3.0-only",
    licenceBoundary: "AGPL",
    projects: projects.map((path) => ({ path, kind: "npm" })),
  });

/** A minimal repository snapshot that satisfies every rule. */
export function baseline(): Sources {
  return {
    "package.json": manifest(),
    "package-lock.json": lock(),
    "wrangler.json": JSON.stringify({
      name: "arcforges-ai-hello",
      main: "src/index.ts",
      workers_dev: false,
      preview_urls: false,
      ai: { binding: "AI" },
      workflows: [{ name: "w", binding: "W", class_name: "Agent" }],
    }),
    "eng/policy/licence-boundary.json": inventory(),
    "src/index.ts": [
      'import { WorkflowEntrypoint } from "cloudflare:workers";',
      'import { sayHello } from "./hello";',
      'import { requestTool } from "./model";',
      "export class Agent extends WorkflowEntrypoint {",
      "  run() {",
      '    return requestTool(this.env.AI, sayHello("x"));',
      "  }",
      "}",
    ].join("\n"),
    "src/hello.ts": [
      'import { SayHelloRequestSchema } from "@arcforges/proto";',
      'import { create, fromBinary, toBinary } from "@bufbuild/protobuf";',
      "export function sayHello(name: string) {",
      "  const request = create(SayHelloRequestSchema, { name });",
      "  return fromBinary(SayHelloRequestSchema, toBinary(SayHelloRequestSchema, request)).name;",
      "}",
    ].join("\n"),
    "src/model.ts": [
      'import { sayHello } from "./hello";',
      "export async function requestTool(ai: Ai, name: string) {",
      '  return ai.run("model", { messages: [sayHello(name)] });',
      "}",
    ].join("\n"),
    "src/deployment.ts": 'export const note = "uses only plain values";\n',
  };
}

export interface Fixture {
  rule: string;
  kind: "pass" | "fail";
  name: string;
  /** Findings produced by the rule engine for this fixture. */
  run: () => Finding[];
}

const sourceFixture = (
  rule: string,
  kind: "pass" | "fail",
  name: string,
  mutate: (sources: Sources) => Sources | undefined,
  options?: AuditOptions,
): Fixture => ({
  rule,
  kind,
  name,
  run: () => {
    const sources = baseline();
    return auditArchitecture(mutate(sources) ?? sources, options);
  },
});
/** The substitution opener, kept out of plain string literals. */
const sub = "$";
const set = (files: Sources) => (sources: Sources) => ({ ...sources, ...files });
const pass = (rule: string, name: string, files: Sources, options?: AuditOptions) =>
  sourceFixture(rule, "pass", name, set(files), options);
const fail = (rule: string, name: string, files: Sources, options?: AuditOptions) =>
  sourceFixture(rule, "fail", name, set(files), options);
const src = (name: string, lines: string[]) => ({ [`src/${name}.ts`]: lines.join("\n") });

const candidate = (): NamingCandidate => ({
  package: "@arcforges/proto",
  version: pin,
  sourceCommit: "a".repeat(40),
  publication: "https://github.com/ArcForges/Contracts/actions/runs/1",
  assets: {
    "tools/naming/eng/check_naming.py": "b".repeat(64),
    "tools/naming/eng/policy/product-names.json": "c".repeat(64),
  },
});
const scanner = new TextEncoder().encode("scanner");
const namingPolicy = new TextEncoder().encode("policy");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashes = { scanner: digest(scanner), policy: digest(namingPolicy) };
const namingFixture = (
  kind: "pass" | "fail",
  name: string,
  adjust: (value: NamingCandidate, installed: { source: Record<string, unknown> }) => unknown,
): Fixture => ({
  rule: "naming-identity",
  kind,
  name,
  run: () => {
    const value = candidate();
    value.assets["tools/naming/eng/check_naming.py"] = hashes.scanner;
    value.assets["tools/naming/eng/policy/product-names.json"] = hashes.policy;
    const installed = {
      source: {
        repository: "https://github.com/ArcForges/Contracts",
        commit: value.sourceCommit,
        version: value.version,
        dirty: false,
      },
    };
    const result = adjust(value, installed);
    return auditNamingCandidate(
      result,
      {
        packageJson: JSON.stringify({ name: "@arcforges/proto", version: pin }),
        sourceJson: JSON.stringify(installed.source),
        assets: {
          "tools/naming/eng/check_naming.py": scanner,
          "tools/naming/eng/policy/product-names.json": namingPolicy,
        },
      },
      pin,
    );
  },
});

/**
 * Every rule has at least one passing and one refused fixture. Passing
 * fixtures are near misses of the refused construct, not unrelated files.
 */
export const fixtures: Fixture[] = [
  // WP-05.00
  pass("layer-cycle", "diamond import without a cycle", {
    ...src("a", ['import "./b";', 'import "./c";']),
    ...src("b", ['import "./d";']),
    ...src("c", ['import "./d";']),
    ...src("d", ["export const d = 1;"]),
  }),
  fail("layer-cycle", "two modules import each other", {
    ...src("hello", ['import "./model";', "export const hello = 1;"]),
  }),
  pass("layer-entry", "entry imports modules", {}),
  fail("layer-entry", "a module imports the Workflow entry", {
    ...src("deployment", ['import "./index";']),
  }),
  pass("layer-escape", "tests import Worker source", {
    "tests/hello.test.ts": 'import { sayHello } from "../src/hello";\nsayHello("x");\n',
  }),
  fail("layer-escape", "Worker source imports a test helper", {
    ...src("deployment", ['import "../tests/helper";']),
    "tests/helper.ts": "export const helper = 1;\n",
  }),
  fail("layer-escape", "Worker source imports a sibling checkout", {
    ...src("deployment", ['import "../../Cloud/src/billing";']),
  }),
  pass("layer-runtime-dependency", "Workers module and declared runtime package", {
    ...src("deployment", ['import { NonRetryableError } from "cloudflare:workflows";']),
  }),
  fail("layer-runtime-dependency", "Worker source imports a development tool", {
    ...src("deployment", ['import "vitest";']),
  }),
  fail("layer-runtime-dependency", "Worker source imports a Node built-in", {
    ...src("deployment", ['import { readFileSync } from "node:fs";']),
  }),
  pass("layer-product-reference", "public wire package", {}),
  fail("layer-product-reference", "private internal package declared", {
    "package.json": manifest({
      dependencies: {
        "@arcforges/proto": pin,
        "@bufbuild/protobuf": "2.15.0",
        "@arcforges/ai-internal": "1.0.0",
      },
    }),
  }),
  fail("layer-product-reference", "private internal package imported", {
    ...src("deployment", ['import "@arcforges/cloud-internal";']),
  }),
  pass("layer-business-authority", "AI, Workflow and version bindings only", {}),
  fail("layer-business-authority", "D1 database binding", {
    "wrangler.json": JSON.stringify({
      workers_dev: false,
      preview_urls: false,
      d1_databases: [{ binding: "DB" }],
    }),
  }),
  fail("layer-business-authority", "R2 store type in Worker source", {
    ...src("deployment", ["export interface Env { BUCKET: R2Bucket }"]),
  }),
  pass("layer-public-exposure", "private Worker", {}),
  fail("layer-public-exposure", "workers.dev enabled", {
    "wrangler.json": JSON.stringify({ workers_dev: true, preview_urls: false }),
  }),
  fail("layer-public-exposure", "public route", {
    "wrangler.json": JSON.stringify({
      workers_dev: false,
      preview_urls: false,
      routes: ["example.invalid/*"],
    }),
  }),
  // WP-05.01
  pass("licence-declaration", "complete declaration and inventory", {}),
  fail("licence-declaration", "no SPDX identifier", {
    "package.json": manifest({ license: undefined }),
  }),
  fail("licence-declaration", "no boundary", {
    "package.json": manifest({ arcforges: undefined }),
  }),
  fail("licence-declaration", "manifest absent from the inventory", {
    "tools/package.json": JSON.stringify({
      name: "x",
      license: "AGPL-3.0-only",
      arcforges: { licenceBoundary: "AGPL" },
    }),
  }),
  pass("licence-boundary-set", "empty Apache set", {}),
  fail("licence-boundary-set", "an unlisted Apache-boundary project", {
    "package.json": manifest({ license: "Apache-2.0", arcforges: { licenceBoundary: "Apache" } }),
  }),
  fail("licence-boundary-set", "AGPL boundary with another licence", {
    "package.json": manifest({ license: "MIT" }),
  }),
  pass("licence-cross-boundary", "AGPL project referencing an AGPL project", {
    "package.json": manifest({
      dependencies: {
        "@arcforges/proto": pin,
        "@bufbuild/protobuf": "2.15.0",
        "@arcforges/tool": "1.0.0",
      },
    }),
    "tools/package.json": JSON.stringify({
      name: "@arcforges/tool",
      license: "AGPL-3.0-only",
      arcforges: { licenceBoundary: "AGPL" },
    }),
    "eng/policy/licence-boundary.json": inventory(["package.json", "tools/package.json"]),
  }),
  fail("licence-cross-boundary", "Apache project referencing the AGPL project", {
    "sdk/package.json": JSON.stringify({
      name: "@arcforges/sdk",
      license: "Apache-2.0",
      arcforges: { licenceBoundary: "Apache" },
      dependencies: { "@arcforges/ai": "1.0.0" },
    }),
    "eng/policy/licence-boundary.json": inventory(["package.json", "sdk/package.json"]),
  }),
  pass("licence-allowlist", "OR expression with an allowed alternative", {
    "package-lock.json": lock({
      "node_modules/dual": { version: "1.0.0", license: "(MIT OR GPL-3.0-only)" },
    }),
  }),
  pass("licence-allowlist", "LGPL in a development-only tool", {
    "package-lock.json": lock({
      "node_modules/tool": { version: "1.0.0", license: "LGPL-3.0-or-later", dev: true },
    }),
  }),
  fail("licence-allowlist", "GPL-only dependency", {
    "package-lock.json": lock({
      "node_modules/gpl": { version: "1.0.0", license: "GPL-3.0-only" },
    }),
  }),
  fail("licence-allowlist", "LGPL in the shipped runtime closure", {
    "package-lock.json": lock({
      "node_modules/lgpl": { version: "1.0.0", license: "LGPL-3.0-or-later" },
    }),
  }),
  fail("licence-allowlist", "dependency without a licence", {
    "package-lock.json": lock({ "node_modules/none": { version: "1.0.0" } }),
  }),
  // WP-05.02
  namingFixture("pass", "candidate equals the installed published assets", (value) => value),
  namingFixture("fail", "changed scanner bytes", (value) => ({
    ...value,
    assets: { ...value.assets, "tools/naming/eng/check_naming.py": "d".repeat(64) },
  })),
  namingFixture("fail", "changed policy bytes", (value) => ({
    ...value,
    assets: { ...value.assets, "tools/naming/eng/policy/product-names.json": "e".repeat(64) },
  })),
  namingFixture("fail", "version differs from the pin", (value) => ({
    ...value,
    version: "1.0.0-ci.2.1",
  })),
  namingFixture("fail", "producer commit differs from source.json", (value) => ({
    ...value,
    sourceCommit: "f".repeat(40),
  })),
  namingFixture("fail", "extra asset", (value) => ({
    ...value,
    assets: { ...value.assets, "tools/naming/extra.py": "a".repeat(64) },
  })),
  namingFixture("fail", "publication outside the producer", (value) => ({
    ...value,
    publication: "https://example.invalid/runs/1",
  })),
  // WP-05.03
  pass("wire-package", "exact registry-locked candidate", {}),
  fail("wire-package", "floating selector", {
    "package.json": manifest({
      dependencies: { "@arcforges/proto": `^${pin}`, "@bufbuild/protobuf": "2.15.0" },
    }),
  }),
  fail("wire-package", "non-registry tarball", {
    "package-lock.json": lock({
      "node_modules/@arcforges/proto": {
        version: pin,
        resolved: "https://example.invalid/proto.tgz",
        integrity,
        license: "Apache-2.0",
      },
    }),
  }),
  fail("wire-package", "declared only as a development dependency", {
    "package.json": manifest({
      dependencies: { "@bufbuild/protobuf": "2.15.0" },
      devDependencies: { "@arcforges/proto": pin },
    }),
  }),
  pass("wire-import", "package root", {}),
  fail("wire-import", "build output subpath", {
    ...src("deployment", [
      'import { SayHelloRequestSchema } from "@arcforges/proto/dist/index.js";',
    ]),
  }),
  pass("wire-source", "application code", {}),
  fail("wire-source", "copied generated module", {
    "src/gen/hello_pb.ts": "export const copied = 1;\n",
  }),
  fail("wire-source", "authored schema file", { "proto/hello.proto": 'syntax = "proto3";\n' }),
  fail("wire-source", "protoc output header", {
    ...src("deployment", ["// @generated by protoc-gen-es v2", "export const copied = 1;"]),
  }),
  pass("wire-codec", "generated schema through the runtime", {}),
  fail("wire-codec", "wire reader import", {
    ...src("deployment", [
      'import { BinaryReader } from "@bufbuild/protobuf/wire";',
      "void BinaryReader;",
    ]),
  }),
  fail("wire-codec", "alternative runtime", { ...src("deployment", ['import "protobufjs";']) }),
  fail("wire-codec", "manual varint masks", {
    ...src("deployment", ["export const low = (byte: number) => (byte & 0x7f) | 0x80;"]),
  }),
  pass("wire-schema", "schema imported from the published package", {}),
  fail("wire-schema", "locally defined schema", {
    ...src("deployment", [
      'import { fromBinary } from "@bufbuild/protobuf";',
      "const localSchema = {};",
      "export const decode = (bytes: Uint8Array) => fromBinary(localSchema as never, bytes);",
    ]),
  }),
  pass(
    "wire-shadow",
    "unrelated local type",
    { ...src("deployment", ["export interface HelloParams { name: string }"]) },
    { generatedNames: new Set(["SayHelloRequest"]) },
  ),
  fail(
    "wire-shadow",
    "local redefinition of a generated message",
    { ...src("deployment", ["export interface SayHelloRequest { name: string }"]) },
    { generatedNames: new Set(["SayHelloRequest"]) },
  ),
  // WP-05.04
  pass("banned-reflection", "ordinary object keys", {
    ...src("deployment", ["export const k = Object.keys({});"]),
  }),
  fail("banned-reflection", "Reflect entry point", {
    ...src("deployment", ["export const k = Reflect.ownKeys({});"]),
  }),
  fail("banned-reflection", "prototype mutation", {
    ...src("deployment", ["export const k = (o: object) => Object.setPrototypeOf(o, null);"]),
  }),
  pass("banned-dynamic-code", "banned names only in strings and comments", {
    ...src("deployment", [
      "// eval and new Function are text here",
      'export const note = "eval(Function)";',
    ]),
  }),
  fail("banned-dynamic-code", "Function constructor", {
    ...src("deployment", ['export const f = new Function("return 1");']),
  }),
  fail("banned-dynamic-code", "eval", {
    ...src("deployment", ['export const f = () => eval("1");']),
  }),
  fail("banned-dynamic-code", "computed import", {
    ...src("deployment", [`export const load = (name: string) => import(\`./${sub}{name}\`);`]),
  }),
  pass("banned-blocking-wait", "asynchronous timer", {
    ...src("deployment", [
      "export const wait = () => new Promise((done) => setTimeout(done, 10));",
    ]),
  }),
  fail("banned-blocking-wait", "Atomics.wait", {
    ...src("deployment", ["export const wait = (cell: Int32Array) => Atomics.wait(cell, 0, 0);"]),
  }),
  fail("banned-blocking-wait", "synchronous host call", {
    ...src("deployment", [
      'export const read = (fs: { readFileSync(path: string): string }) => fs.readFileSync("x");',
    ]),
  }),
  fail("banned-blocking-wait", "clock busy-wait", {
    ...src("deployment", ["export const spin = () => { while (Date.now() < 5) {} };"]),
  }),
  pass("banned-provider-sdk", "adapter uses the Workers AI binding", {}),
  fail("banned-provider-sdk", "provider SDK import", {
    ...src("deployment", ['import "openai";']),
  }),
  fail("banned-provider-sdk", "direct provider endpoint", {
    ...src("deployment", ['export const url = "https://api.anthropic.com/v1/messages";']),
  }),
  pass("banned-provider-call", "binding called inside the adapter", {}),
  fail("banned-provider-call", "binding called outside the adapter", {
    ...src("deployment", ['export const call = (env: { AI: Ai }) => env.AI.run("model", {});']),
  }),
  pass("banned-secret-logging", "static status message", {
    ...src("deployment", ['console.log("started");']),
  }),
  fail("banned-secret-logging", "logging a token", {
    ...src("deployment", ["const token = 'x'; console.log(token);"]),
  }),
  fail("banned-secret-logging", "logging the whole environment", {
    ...src("deployment", ["console.log(this.env);"]),
  }),
  fail("banned-secret-logging", "logging inside a template", {
    ...src("deployment", [`const prompt = 'x'; console.error(\`failed: ${sub}{prompt}\`);`]),
  }),
  pass("banned-float-money", "integer minor units", {
    ...src("deployment", ["export const priceCents = BigInt(100);"]),
  }),
  fail("banned-float-money", "parseFloat on an amount", {
    ...src("deployment", ['export const amount = parseFloat("1.5");']),
  }),
  fail("banned-float-money", "number-typed credit balance", {
    ...src("deployment", ["export const creditBalance: number = 1;"]),
  }),
  pass("banned-raw-memory", "managed buffer", {
    ...src("deployment", ["export const b = new ArrayBuffer(8);"]),
  }),
  fail("banned-raw-memory", "shared buffer", {
    ...src("deployment", ["export const b = new SharedArrayBuffer(8);"]),
  }),
  fail("banned-raw-memory", "WebAssembly memory", {
    ...src("deployment", ["export const m = new WebAssembly.Memory({ initial: 1 });"]),
  }),
];
