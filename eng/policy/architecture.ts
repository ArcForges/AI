// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type ModuleReference, moduleReferences, type Token, tokenize } from "./source-lexer.ts";

export type Sources = Record<string, string>;
export interface Finding {
  rule: string;
  file: string;
  detail: string;
}
export type Obligation = "WP-05.00" | "WP-05.01" | "WP-05.02" | "WP-05.03" | "WP-05.04";
export interface RuleInfo {
  id: string;
  obligation: Obligation;
  summary: string;
}
export interface AuditOptions {
  /** Message and enum names exported by the installed generated package. */
  generatedNames?: ReadonlySet<string>;
}

/** The complete rule catalogue; every id has a passing and a failing fixture. */
export const RULES: readonly RuleInfo[] = [
  { id: "layer-cycle", obligation: "WP-05.00", summary: "Worker source import graph is acyclic" },
  { id: "layer-entry", obligation: "WP-05.00", summary: "Nothing imports the Workflow entry" },
  {
    id: "layer-escape",
    obligation: "WP-05.00",
    summary: "Worker source reaches only Worker source (no tests, tooling, siblings or URLs)",
  },
  {
    id: "layer-runtime-dependency",
    obligation: "WP-05.00",
    summary: "Worker source imports only declared runtime dependencies and Workers modules",
  },
  {
    id: "layer-product-reference",
    obligation: "WP-05.00",
    summary: "Only the published public contract package may be referenced from another owner",
  },
  {
    id: "layer-business-authority",
    obligation: "WP-05.00",
    summary: "No Cloud business store, queue or Durable Object authority moves into AI",
  },
  {
    id: "layer-public-exposure",
    obligation: "WP-05.00",
    summary: "The Worker has no route, workers.dev or preview exposure",
  },
  {
    id: "licence-declaration",
    obligation: "WP-05.01",
    summary: "Every project declares an SPDX identifier and a boundary matching the inventory",
  },
  {
    id: "licence-boundary-set",
    obligation: "WP-05.01",
    summary: "The Apache-boundary set equals the enumerated list (empty for AI)",
  },
  {
    id: "licence-cross-boundary",
    obligation: "WP-05.01",
    summary: "No Apache-boundary project references an AGPL project",
  },
  {
    id: "licence-allowlist",
    obligation: "WP-05.01",
    summary: "Every locked dependency licence is allowed for the consuming boundary",
  },
  {
    id: "naming-identity",
    obligation: "WP-05.02",
    summary: "The published naming scanner and policy match the recorded producer identity",
  },
  {
    id: "naming-scan",
    obligation: "WP-05.02",
    summary: "The published scanner detects every forbidden term and accepts the current tree",
  },
  {
    id: "wire-package",
    obligation: "WP-05.03",
    summary: "Wire types come from one exact, registry-locked @arcforges/proto pin",
  },
  {
    id: "wire-import",
    obligation: "WP-05.03",
    summary: "Generated types are imported only from the package root",
  },
  {
    id: "wire-source",
    obligation: "WP-05.03",
    summary: "No copied generated source or schema file is authored in this repository",
  },
  {
    id: "wire-codec",
    obligation: "WP-05.03",
    summary: "No handwritten or alternative wire codec",
  },
  {
    id: "wire-schema",
    obligation: "WP-05.03",
    summary: "Runtime codec calls take a generated schema from the published package",
  },
  {
    id: "wire-shadow",
    obligation: "WP-05.03",
    summary: "No local declaration redefines a generated wire type",
  },
  {
    id: "banned-reflection",
    obligation: "WP-05.04",
    summary: "No reflection entry points on the Worker path",
  },
  {
    id: "banned-dynamic-code",
    obligation: "WP-05.04",
    summary: "No dynamic code generation or computed imports on the Worker path",
  },
  {
    id: "banned-blocking-wait",
    obligation: "WP-05.04",
    summary: "No blocking waits or synchronous host calls on async paths",
  },
  {
    id: "banned-provider-sdk",
    obligation: "WP-05.04",
    summary: "No provider SDK import or direct provider endpoint call",
  },
  {
    id: "banned-provider-call",
    obligation: "WP-05.04",
    summary: "The inference binding is called only inside the model adapter",
  },
  {
    id: "banned-secret-logging",
    obligation: "WP-05.04",
    summary: "No logging of secret-bearing or content-bearing values",
  },
  {
    id: "banned-float-money",
    obligation: "WP-05.04",
    summary: "No floating-point arithmetic or number type in money and credit paths",
  },
  {
    id: "banned-raw-memory",
    obligation: "WP-05.04",
    summary: "No raw linear-memory handles",
  },
];

export const ENTRY = "src/index.ts";
export const ADAPTER = "src/model.ts";
export const PUBLIC_WIRE_PACKAGE = "@arcforges/proto";
/** The enumerated Apache-2.0 boundary projects of this repository: none. */
export const APACHE_BOUNDARY_PROJECTS: readonly string[] = [];

const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const exact = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u;
const codeFile = /\.[cm]?[jt]s$/u;
const releaseFile = /^src\/.+\.[cm]?ts$/u;
const declarationFile = /\.d\.[cm]?ts$/u;
const forbiddenBindings = [
  "d1_databases",
  "r2_buckets",
  "kv_namespaces",
  "durable_objects",
  "queues",
  "hyperdrive",
  "migrations",
];
const forbiddenTypes = new Set([
  "D1Database",
  "R2Bucket",
  "KVNamespace",
  "DurableObject",
  "DurableObjectNamespace",
  "DurableObjectState",
  "Hyperdrive",
  "Queue",
]);
const providerPackages =
  /^(?:openai|@openai\/|@anthropic-ai\/|@google\/(?:genai|generative-ai)|@google-cloud\/(?:vertexai|aiplatform)|@mistralai\/|@aws-sdk\/client-bedrock|@azure\/openai|cohere-ai|groq-sdk|ollama|replicate|together-ai|langchain|@langchain\/|ai$|@ai-sdk\/)/u;
const providerHosts =
  /(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.cohere\.(?:ai|com)|api\.mistral\.ai|api\.groq\.com|openrouter\.ai|api\.together\.xyz|api\.replicate\.com|bedrock-runtime|api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai)/iu;
const wireCodecPackages =
  /^(?:@bufbuild\/protobuf\/(?:wire|codegenv\d+|reflect)(?:\/|$)|protobufjs(?:\/|$)|google-protobuf(?:\/|$)|@protobuf-ts\/|ts-proto|pbf$|long$)/u;
const codecFunctions = new Set([
  "create",
  "fromBinary",
  "toBinary",
  "fromJson",
  "toJson",
  "fromJsonString",
  "toJsonString",
  "clone",
  "equals",
]);
const sensitiveName =
  /secret|token|passw|credential|api[_-]?key|authoriz|cookie|session|prompt|messages?|content|conversation|completion|transcript|payload|^env$|^headers$|^request$|^body$/iu;
const moneyParts = new Set([
  "credit",
  "credits",
  "balance",
  "balances",
  "money",
  "price",
  "prices",
  "amount",
  "amounts",
  "cost",
  "costs",
  "charge",
  "charges",
  "billing",
  "currency",
  "fee",
  "fees",
  "invoice",
  "payment",
  "payments",
  "refund",
  "usd",
  "cent",
  "cents",
  "tax",
]);

const parse = (source: string | undefined) => {
  try {
    return JSON.parse(source ?? "null") as unknown;
  } catch {
    return null;
  }
};
type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record(value) ?? {}).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
const packageName = (specifier: string) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
const identifierParts = (name: string) =>
  name
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[_$]+/u)
    .filter(Boolean);

const allowedAgpl = new Set([
  "0BSD",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);
// LGPL-3.0 code may be combined into an AGPL-3.0 work, but only as a
// development-tool input: the shipped runtime closure stays permissive/AGPL.
const developmentOnlyAgpl = new Set(["LGPL-3.0-only", "LGPL-3.0-or-later"]);
const allowedApache = new Set([...allowedAgpl].filter((id) => !id.startsWith("AGPL")));

/** Evaluate an SPDX expression: OR needs one allowed alternative, AND needs all. */
export function licenceAllowed(expression: string | undefined, allowed: ReadonlySet<string>) {
  if (!expression || /\s(?:WITH)\s/u.test(expression)) return false;
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+-]+/gu) ?? [];
  let index = 0;
  const or = (): boolean => {
    let result = and();
    while (tokens[index] === "OR") {
      index++;
      const next = and();
      result = result || next;
    }
    return result;
  };
  const and = (): boolean => {
    let result = factor();
    while (tokens[index] === "AND") {
      index++;
      const next = factor();
      result = result && next;
    }
    return result;
  };
  const factor = (): boolean => {
    const token = tokens[index++];
    if (token === "(") {
      const inner = or();
      if (tokens[index++] !== ")") return false;
      return inner;
    }
    return token !== undefined && token !== ")" && allowed.has(token);
  };
  const result = or();
  return result && index === tokens.length;
}

function resolveLocal(from: string, target: string, sources: Sources) {
  const stem = path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
  if (stem.startsWith("../")) return { escaped: true as const, file: undefined };
  const base = stem.replace(/\.[cm]?js$/u, "");
  const file = [stem, `${base}.ts`, `${base}.mts`, `${base}/index.ts`].find((name) =>
    Object.hasOwn(sources, name),
  );
  return { escaped: false as const, file, stem };
}

function arguments_(tokens: Token[], open: number) {
  let depth = 0;
  const found: Token[] = [];
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index] as Token;
    if (token.kind === "punct" && ["(", "[", "{", "${"].includes(token.value)) depth++;
    else if (token.kind === "punct" && [")", "]", "}"].includes(token.value)) {
      depth--;
      if (depth === 0) break;
    }
    if (index > open) found.push(token);
  }
  return found;
}

export function auditArchitecture(sources: Sources, options: AuditOptions = {}): Finding[] {
  const findings: Finding[] = [];
  const report = (rule: string, file: string, detail: string) => {
    if (
      !findings.some((item) => item.rule === rule && item.file === file && item.detail === detail)
    )
      findings.push({ rule, file, detail });
  };
  const root = record(parse(sources["package.json"])) ?? {};
  const lock = record(parse(sources["package-lock.json"]));
  const lockPackages = record(lock?.packages) ?? {};
  const manifests = Object.keys(sources)
    .filter((file) => path.posix.basename(file) === "package.json")
    .sort();
  const runtimeDependencies = new Set(Object.keys(stringMap(root.dependencies)));

  // --- WP-05.00 layering and reference direction (manifests and Worker configuration)
  const ownProjects = new Set(
    manifests.map((file) => record(parse(sources[file]))?.name).filter((name) => name),
  );
  for (const file of manifests)
    for (const section of sections)
      for (const name of Object.keys(stringMap(record(parse(sources[file]))?.[section])))
        if (
          name.toLowerCase().startsWith("@arcforges/") &&
          name !== PUBLIC_WIRE_PACKAGE &&
          !ownProjects.has(name)
        )
          report("layer-product-reference", file, `Unadmitted ArcForges package: ${name}`);
  const wrangler = record(parse(sources["wrangler.json"]));
  if (!wrangler)
    report("layer-public-exposure", "wrangler.json", "Worker configuration is missing");
  else {
    for (const key of forbiddenBindings)
      if (key in wrangler)
        report("layer-business-authority", "wrangler.json", `Business authority binding: ${key}`);
    if (wrangler.workers_dev !== false)
      report("layer-public-exposure", "wrangler.json", "workers_dev must be false");
    if (wrangler.preview_urls !== false)
      report("layer-public-exposure", "wrangler.json", "preview_urls must be false");
    for (const key of ["routes", "route"])
      if (key in wrangler) report("layer-public-exposure", "wrangler.json", `Public ${key}`);
  }

  // --- Source graph: lexical import graph over every code file
  const references = new Map<string, ModuleReference[]>();
  const tokenized = new Map<string, Token[]>();
  const edges = new Map<string, string[]>();
  for (const [file, source] of Object.entries(sources)) {
    if (!codeFile.test(file) || declarationFile.test(file)) continue;
    const tokens = tokenize(source);
    tokenized.set(file, tokens);
    references.set(file, moduleReferences(tokens));
  }
  for (const [file, list] of references) {
    const targets: string[] = [];
    const release = releaseFile.test(file);
    for (const reference of list) {
      const { specifier } = reference;
      if (specifier === null) {
        report(
          release ? "banned-dynamic-code" : "layer-escape",
          file,
          `Computed ${reference.form} specifier needs explicit admission`,
        );
        continue;
      }
      if (
        specifier.startsWith("@arcforges/") &&
        !specifier.startsWith(`${PUBLIC_WIRE_PACKAGE}/`) &&
        specifier !== PUBLIC_WIRE_PACKAGE
      )
        report("layer-product-reference", file, `Unadmitted ArcForges import: ${specifier}`);
      if (/^(?:[a-z][a-z\d+.-]*:\/\/|file:|git\+|[A-Za-z]:[\\/]|\/)/iu.test(specifier))
        report("layer-escape", file, `External or absolute import: ${specifier}`);
      if (specifier.startsWith(".")) {
        const resolved = resolveLocal(file, specifier, sources);
        if (resolved.escaped)
          report("layer-escape", file, `Sibling or parent checkout import: ${specifier}`);
        else if (!resolved.file && !/\.(?:json|css|txt|md)$/u.test(specifier))
          report("layer-escape", file, `Unresolved local import: ${specifier}`);
        else if (resolved.file) {
          targets.push(resolved.file);
          if (release && !releaseFile.test(resolved.file))
            report("layer-escape", file, `Worker source reaches ${resolved.file}`);
          if (resolved.file === ENTRY && file !== ENTRY)
            report("layer-entry", file, `Imports the Workflow entry: ${specifier}`);
        }
        continue;
      }
      if (release) {
        if (specifier.startsWith("node:"))
          report(
            "layer-runtime-dependency",
            file,
            `Node built-in in the Worker path: ${specifier}`,
          );
        else if (/^cloudflare:/u.test(specifier)) continue;
        else if (!runtimeDependencies.has(packageName(specifier)))
          report(
            "layer-runtime-dependency",
            file,
            `Not a declared runtime dependency: ${packageName(specifier)}`,
          );
      }
    }
    edges.set(file, targets);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const walk = (file: string, stack: string[]) => {
    if (done.has(file)) return;
    if (visiting.has(file)) {
      report(
        "layer-cycle",
        file,
        `Import cycle: ${[...stack.slice(stack.indexOf(file)), file].join(" -> ")}`,
      );
      return;
    }
    visiting.add(file);
    for (const next of edges.get(file) ?? [])
      if (releaseFile.test(next)) walk(next, [...stack, file]);
    visiting.delete(file);
    done.add(file);
  };
  for (const file of [...edges.keys()].filter((name) => releaseFile.test(name)).sort())
    walk(file, []);

  // --- WP-05.01 licence boundary
  const inventory = record(parse(sources["eng/policy/licence-boundary.json"]));
  const rows = Array.isArray(inventory?.projects) ? (inventory.projects as unknown[]) : [];
  const projectNames = new Map<string, string>();
  const boundaries = new Map<string, string>();
  for (const file of manifests) {
    const manifest = record(parse(sources[file])) ?? {};
    const boundary = record(manifest.arcforges)?.licenceBoundary;
    if (typeof manifest.name === "string") projectNames.set(manifest.name, file);
    if (typeof boundary === "string") boundaries.set(file, boundary);
    if (typeof manifest.license !== "string" || !/^[A-Za-z0-9.+-]+$/u.test(manifest.license))
      report("licence-declaration", file, "SPDX licence identifier is missing");
    if (boundary !== "AGPL" && boundary !== "Apache")
      report("licence-declaration", file, "Licence boundary is missing or unknown");
    if (boundary === "AGPL" && manifest.license !== "AGPL-3.0-only")
      report("licence-boundary-set", file, "AGPL boundary requires AGPL-3.0-only");
    if (boundary === "Apache" && manifest.license !== "Apache-2.0")
      report("licence-boundary-set", file, "Apache boundary requires Apache-2.0");
  }
  const inventoryPaths = rows.map((row) => record(row)?.path);
  if (
    JSON.stringify([...inventoryPaths].sort()) !== JSON.stringify(manifests) ||
    inventory?.licenceBoundary === undefined
  )
    report("licence-declaration", "eng/policy/licence-boundary.json", "Project inventory drift");
  for (const row of rows) {
    const item = record(row);
    const file = typeof item?.path === "string" ? item.path : "";
    const manifest = record(parse(sources[file]));
    if (manifest && manifest.license !== inventory?.spdxLicense && boundaries.get(file) === "AGPL")
      report("licence-declaration", file, "Manifest licence differs from the inventory");
  }
  const apache = [...boundaries].filter(([, value]) => value === "Apache").map(([file]) => file);
  if (JSON.stringify(apache.sort()) !== JSON.stringify([...APACHE_BOUNDARY_PROJECTS].sort()))
    report(
      "licence-boundary-set",
      "package.json",
      `Apache-boundary projects differ from the enumerated list: ${apache.join(", ") || "none"}`,
    );
  for (const file of apache)
    for (const section of sections)
      for (const name of Object.keys(stringMap(record(parse(sources[file]))?.[section]))) {
        const target = projectNames.get(name);
        if (target && boundaries.get(target) !== "Apache")
          report("licence-cross-boundary", file, `Apache project references AGPL project ${name}`);
      }
  const apacheRoot = boundaries.get("package.json") === "Apache";
  for (const [key, value] of Object.entries(lockPackages)) {
    if (!key.includes("node_modules/")) continue;
    const item = record(value);
    const expression = item?.license;
    const developmentOnly = item?.dev === true || item?.devOptional === true;
    const consumer = apacheRoot
      ? allowedApache
      : developmentOnly
        ? new Set([...allowedAgpl, ...developmentOnlyAgpl])
        : allowedAgpl;
    if (!licenceAllowed(typeof expression === "string" ? expression : undefined, consumer))
      report(
        "licence-allowlist",
        "package-lock.json",
        `${key.split("node_modules/").at(-1)}: ${typeof expression === "string" ? expression : "no licence"}`,
      );
  }

  // --- WP-05.03 generated-client consumption
  const pin = stringMap(root.dependencies)[PUBLIC_WIRE_PACKAGE];
  const entry = record(lockPackages[`node_modules/${PUBLIC_WIRE_PACKAGE}`]);
  const tarball = `https://registry.npmjs.org/${PUBLIC_WIRE_PACKAGE}/-/proto-${pin}.tgz`;
  if (
    !pin ||
    !exact.test(pin) ||
    !pin.includes("-ci.") ||
    entry?.version !== pin ||
    entry?.resolved !== tarball ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(String(entry?.integrity ?? "")) ||
    stringMap(record(lockPackages[""])?.dependencies)[PUBLIC_WIRE_PACKAGE] !== pin
  )
    report(
      "wire-package",
      "package.json",
      "Exact registry-locked published candidate pin of the public wire package required",
    );
  for (const section of sections.filter((name) => name !== "dependencies"))
    if (PUBLIC_WIRE_PACKAGE in stringMap(root[section]))
      report("wire-package", "package.json", `Wire package declared as ${section}`);
  for (const file of Object.keys(sources))
    if (/\.proto$|_pb\.(?:[cm]?[jt]s|d\.ts)$|\.pb\.[cm]?[jt]s$|_connect\.[cm]?[jt]s$/u.test(file))
      report("wire-source", file, "Authored schema or copied generated wire source");
  for (const [file, source] of Object.entries(sources))
    if (
      codeFile.test(file) &&
      !declarationFile.test(file) &&
      /@generated by protoc-gen|Generated by the protocol buffer compiler/u.test(source) &&
      !file.startsWith("tests/ArchitectureTests/") &&
      !file.startsWith("eng/policy/")
    )
      report("wire-source", file, "Generated protocol buffer output authored in this repository");

  // --- Per-file token rules
  for (const [file, tokens] of tokenized) {
    const list = references.get(file) ?? [];
    const release = releaseFile.test(file);
    const bound = new Map<string, string>(); // local name -> source package
    for (const reference of list) {
      if (reference.specifier === null) continue;
      for (const [local] of reference.bindings) bound.set(local, packageName(reference.specifier));
      const { specifier } = reference;
      if (
        specifier.startsWith(`${PUBLIC_WIRE_PACKAGE}/`) ||
        /(?:^|\/)node_modules\/@arcforges\//u.test(specifier)
      )
        report(
          "wire-import",
          file,
          `Generated types must come from the package root: ${specifier}`,
        );
      if (/@arcforges\/proto\/dist|(?:^|\/)dist\/gen\//u.test(specifier))
        report("wire-import", file, `Generated build output import: ${specifier}`);
      if (wireCodecPackages.test(specifier))
        report("wire-codec", file, `Handwritten or alternative wire codec: ${specifier}`);
      if (providerPackages.test(specifier))
        report("banned-provider-sdk", file, `Provider SDK import: ${specifier}`);
    }
    const hex = new Set(
      tokens
        .filter((token) => token.kind === "number")
        .map((token) => token.value.toLowerCase().replaceAll("_", "")),
    );
    const names = new Set(
      tokens.filter((token) => token.kind === "word").map((token) => token.value),
    );
    // Build tooling may read the protobuf runtime's licence header; the codec rule
    // concerns authored product and test code.
    if (
      !file.startsWith("eng/") &&
      (["BinaryWriter", "BinaryReader", "varint"].some((name) => names.has(name)) ||
        (hex.has("0x7f") && hex.has("0x80")))
    )
      report("wire-codec", file, "Manual varint or binary reader/writer logic");
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index] as Token;
      const next = tokens[index + 1];
      const before = tokens[index - 1];
      if (token.kind === "string" || token.kind === "template") {
        if (release && providerHosts.test(token.value))
          report("banned-provider-sdk", file, "Direct provider endpoint literal");
        if (release && /^(?:setTimeout|setInterval)$/u.test(before?.value ?? "")) continue;
        continue;
      }
      if (token.kind !== "word") continue;
      const afterDot = before?.kind === "punct" && (before.value === "." || before.value === "?.");
      if (
        options.generatedNames?.has(token.value) &&
        /(?:Request|Response|Event|Reply|Command|Query)$/u.test(token.value) &&
        !afterDot &&
        before?.kind === "word" &&
        ["interface", "type", "class", "enum", "const", "let", "var", "function"].includes(
          before.value,
        )
      )
        report("wire-shadow", file, `Local declaration redefines generated type ${token.value}`);
      if (codecFunctions.has(token.value) && next?.value === "(" && !afterDot) {
        const first = tokens[index + 2];
        if (bound.get(token.value) === "@bufbuild/protobuf") {
          if (first?.kind !== "word" || bound.get(first.value) !== PUBLIC_WIRE_PACKAGE)
            report(
              "wire-schema",
              file,
              `${token.value} must take a generated schema imported from ${PUBLIC_WIRE_PACKAGE}`,
            );
        }
      }
      if (!release) continue;
      const call = next?.value === "(";
      if (token.value === "Reflect" && next?.value === ".")
        report("banned-reflection", file, "Reflect entry point");
      if (token.value === "__proto__" || token.value === "setPrototypeOf")
        report("banned-reflection", file, token.value);
      if (
        token.value === "constructor" &&
        next?.value === "." &&
        tokens[index + 2]?.value === "constructor"
      )
        report("banned-reflection", file, "constructor.constructor");
      if (token.value === "eval" && call && !afterDot) report("banned-dynamic-code", file, "eval");
      if (token.value === "Function" && (call || before?.value === "new") && !afterDot)
        report("banned-dynamic-code", file, "Function constructor");
      if (
        (token.value === "setTimeout" || token.value === "setInterval") &&
        call &&
        (tokens[index + 2]?.kind === "string" || tokens[index + 2]?.kind === "template")
      )
        report("banned-dynamic-code", file, `${token.value} with a code string`);
      if (token.value === "importScripts" && call)
        report("banned-dynamic-code", file, "importScripts");
      if (token.value === "WebAssembly" && next?.value === ".") {
        const member = tokens[index + 2]?.value ?? "";
        if (member === "Memory") report("banned-raw-memory", file, "WebAssembly.Memory");
        else report("banned-dynamic-code", file, `WebAssembly.${member}`);
      }
      if (token.value === "SharedArrayBuffer")
        report("banned-raw-memory", file, "SharedArrayBuffer");
      if (token.value === "Atomics" && next?.value === ".") {
        if (tokens[index + 2]?.value === "wait")
          report("banned-blocking-wait", file, "Atomics.wait");
        else report("banned-raw-memory", file, `Atomics.${tokens[index + 2]?.value ?? ""}`);
      }
      if (/Sync$/u.test(token.value) && call && afterDot)
        report("banned-blocking-wait", file, `Synchronous host call ${token.value}`);
      if (
        token.value === "while" &&
        tokens
          .slice(index, index + 10)
          .some((item, offset, window) => item.value === "now" && window[offset - 1]?.value === ".")
      )
        report("banned-blocking-wait", file, "Busy-wait on the clock");
      if (token.value === "XMLHttpRequest") report("banned-blocking-wait", file, "XMLHttpRequest");
      if (forbiddenTypes.has(token.value) && !afterDot)
        report("layer-business-authority", file, `Cloud-owned business store type ${token.value}`);
      if (token.value === "AI" && afterDot && file !== ENTRY && file !== ADAPTER)
        report(
          "banned-provider-call",
          file,
          "Inference binding referenced outside the entry/adapter",
        );
      if (
        token.value === "run" &&
        call &&
        afterDot &&
        before !== undefined &&
        /^(?:ai|AI)$/u.test(tokens[index - 2]?.value ?? "") &&
        file !== ADAPTER
      )
        report("banned-provider-call", file, "Inference binding called outside the model adapter");
      if (token.value === "console" && next?.value === "." && tokens[index + 3]?.value === "(") {
        for (const argument of arguments_(tokens, index + 3))
          if (argument.kind === "word" && sensitiveName.test(argument.value))
            report(
              "banned-secret-logging",
              file,
              `console.${tokens[index + 2]?.value ?? ""} receives ${argument.value}`,
            );
      }
      const parts = identifierParts(token.value);
      if (parts.some((part) => moneyParts.has(part))) {
        const window: Token[] = [];
        for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 14); cursor++) {
          const item = tokens[cursor] as Token;
          if (item.kind === "punct" && [";", "}"].includes(item.value)) break;
          window.push(item);
        }
        const floating =
          window.some((item, offset) => {
            if (item.kind === "number")
              return /\.|e/iu.test(item.value) && !/^0x/iu.test(item.value);
            if (item.kind === "word")
              return (
                ["parseFloat", "toFixed", "toPrecision", "fround"].includes(item.value) ||
                (item.value === "Math" && window[offset + 1]?.value === ".")
              );
            return false;
          }) ||
          (window[0]?.value === ":" && window[1]?.value === "number") ||
          (window[0]?.value === "?" && window[1]?.value === ":" && window[2]?.value === "number");
        if (floating)
          report("banned-float-money", file, `Floating-point handling near ${token.value}`);
      }
    }
  }
  return findings.sort((a, b) =>
    `${a.rule}\0${a.file}\0${a.detail}`.localeCompare(`${b.rule}\0${b.file}\0${b.detail}`),
  );
}

const inventoryFile = /\.(?:[cm]?[jt]s|json|proto)$|(?:^|\/)\.node-version$|(?:^|\/)\.npmrc$/u;

/** Read the real Git inventory (tracked and nonignored files) into Sources. */
export function readInventory(root: string): { sources: Sources; names: string[] } {
  const names = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
      ),
    },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const sources: Sources = {};
  for (const name of names) {
    if (!inventoryFile.test(name) || name.startsWith("artifacts/")) continue;
    if (/(?:^|\/)package-lock\.json$/u.test(name) || name.endsWith(".json") || codeFile.test(name))
      sources[name] = readFileSync(path.join(root, name), "utf8");
    else sources[name] = "";
  }
  return { sources, names };
}

export function generatedWireNames(root: string): Set<string> {
  const names = new Set<string>();
  const directory = path.join(root, "node_modules", PUBLIC_WIRE_PACKAGE, "dist");
  const listed: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (file.endsWith("_pb.d.ts")) listed.push(file);
    }
  };
  // Without an installed package there is nothing to shadow; the pin rules still apply.
  if (existsSync(directory)) visit(directory);
  for (const file of listed)
    for (const match of readFileSync(file, "utf8").matchAll(
      /export (?:declare )?(?:type|enum) (\w+)/gu,
    ))
      names.add(match[1] as string);
  return names;
}

export function auditRepository(root: string) {
  const { sources, names } = readInventory(root);
  const findings = auditArchitecture(sources, { generatedNames: generatedWireNames(root) });
  return { repository: "AI", inventoryFiles: names.length, rules: RULES.length, findings };
}
