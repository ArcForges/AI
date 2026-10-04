# AI architecture policy

`eng/project.mjs check`, already part of the required `npm run check` pull-request gate, runs
`eng/policy/run.ts`. It audits the real Git inventory (tracked and nonignored files) with
`architecture.ts`, applies the owned expiring exceptions in `exceptions.json`, verifies the
published naming-tool identity in `naming-candidate.json` and only then executes the published
scanner. The policy is pure Node/TypeScript and runs offline: no Workers AI call, Workflow run,
network service, browser or device is involved. It mirrors the mechanism of the Web policy
(GOV.11) and is necessarily separate code from the .NET rule engine (GOV.04), which cannot run in
this repository. The lexer in `source-lexer.ts` (comments, strings, templates and regular
expressions are opaque; module declarations are read from tokens) replaces a parser dependency,
because the pin of the naming-tool candidate is the only dependency version change this policy
makes. Computed imports and unresolved local code fail closed.

The suite is `tests/ArchitectureTests`. Every rule below has at least one passing and one refused
fixture in `fixtures.ts`; `architecture.test.ts` fails if a rule loses either side, if a rule is
undocumented here, or if an obligation has no rule. Further rules are appended; a rule is never
removed or weakened without a reviewed policy change.

| Rule                       | Obligation | Passing fixture                                                     | Refused fixture                                                                      |
| -------------------------- | ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `layer-cycle`              | WP-05.00   | Diamond import graph                                                | Two Worker modules importing each other                                              |
| `layer-entry`              | WP-05.00   | The entry imports modules                                           | A module importing the Workflow entry                                                |
| `layer-escape`             | WP-05.00   | Tests importing Worker source                                       | Worker source importing a test helper or a sibling checkout                          |
| `layer-runtime-dependency` | WP-05.00   | `cloudflare:` module and declared runtime package                   | Development tool or Node built-in in the Worker path                                 |
| `layer-product-reference`  | WP-05.00   | The public wire package                                             | Another ArcForges package declared or imported                                       |
| `layer-business-authority` | WP-05.00   | AI, Workflow and version bindings only                              | D1, R2, KV, Durable Object or queue binding or type                                  |
| `layer-public-exposure`    | WP-05.00   | Private Worker                                                      | `workers_dev`, preview URL or route                                                  |
| `licence-declaration`      | WP-05.01   | SPDX identifier, boundary and matching inventory                    | Missing identifier, missing boundary, manifest absent from the inventory             |
| `licence-boundary-set`     | WP-05.01   | Empty Apache set                                                    | Unlisted Apache project; AGPL boundary with another licence                          |
| `licence-cross-boundary`   | WP-05.01   | AGPL project referencing an AGPL project                            | Apache project referencing the AGPL project                                          |
| `licence-allowlist`        | WP-05.01   | `OR` with an allowed alternative; LGPL in a development-only tool   | GPL-only, licence-less or LGPL runtime dependency                                    |
| `naming-identity`          | WP-05.02   | Candidate equals the installed published assets                     | Changed scanner or policy bytes, version, commit, extra asset or foreign publication |
| `naming-scan`              | WP-05.02   | Current terms; zero findings on the current tree (`naming.test.ts`) | Every name in the published forbidden-name list, in an isolated local Git fixture    |
| `wire-package`             | WP-05.03   | Exact registry-locked published candidate                           | Floating selector, non-registry tarball, development-only declaration                |
| `wire-import`              | WP-05.03   | Package root                                                        | Build-output or subpath import                                                       |
| `wire-source`              | WP-05.03   | Application code                                                    | Copied `_pb` module, authored `.proto`, protoc output header                         |
| `wire-codec`               | WP-05.03   | Generated schema through the protobuf runtime                       | Wire reader/writer import, alternative runtime, manual varint masks                  |
| `wire-schema`              | WP-05.03   | Schema imported from the published package                          | Codec call with a locally defined schema                                             |
| `wire-shadow`              | WP-05.03   | Unrelated local type                                                | Local redefinition of a generated message                                            |
| `banned-reflection`        | WP-05.04   | Ordinary object keys                                                | `Reflect`, prototype mutation                                                        |
| `banned-dynamic-code`      | WP-05.04   | Banned names only in strings and comments                           | `eval`, `Function`, `WebAssembly` compilation, computed import                       |
| `banned-blocking-wait`     | WP-05.04   | Asynchronous timer                                                  | `Atomics.wait`, `*Sync` host call, clock busy-wait                                   |
| `banned-provider-sdk`      | WP-05.04   | Adapter uses the Workers AI binding                                 | Provider SDK import or provider endpoint literal                                     |
| `banned-provider-call`     | WP-05.04   | Binding called inside `src/model.ts`                                | Binding called anywhere else                                                         |
| `banned-secret-logging`    | WP-05.04   | Static status message                                               | Logging a token, the environment or a prompt, including inside a template            |
| `banned-float-money`       | WP-05.04   | Integer minor units                                                 | `parseFloat`/`Math`/decimal literal or `number` type in a money or credit identifier |
| `banned-raw-memory`        | WP-05.04   | Managed buffer                                                      | `SharedArrayBuffer`, `WebAssembly.Memory`, `Atomics`                                 |

`exceptions.json` is empty. An exception names one exact finding (rule, file and detail), an owner, a
reason of substance and a lifetime of at most 180 days; an expired, malformed, over-long or unused
entry is itself a finding (`exceptions.test.ts`), so an exception cannot outlive the condition it
covers.

## Scope and limits

- The rules are static source and manifest rules over the Git inventory, not proof of runtime
  behavior and not a sandbox for arbitrary dynamic JavaScript; unsupported dynamic forms are
  refused rather than analysed. `banned-float-money` and `banned-secret-logging` are lexical
  heuristics over identifiers; `banned-raw-memory` is the TypeScript analogue of the raw-pointer
  category, which has no other expression in a Worker.
- AI has no .NET project, contract project or Apache-boundary project, so the .NET-only layering
  assertions have no subject here; the Apache set is enumerated as empty and any addition fails.
- The business-authority and exposure rules describe the Hello baseline Worker configuration:
  adding a binding that Cloud owns requires a reviewed policy change, not an exception.
- Licence checks evaluate the declared SPDX expressions of the locked closure. They are an
  allowlist gate, not a redistribution review; file-level provenance and legal records remain the
  authority (`docs/provenance.md`).
- The naming scanner is the build-only asset of `@arcforges/proto` in `naming-candidate.json`
  (package version, producer commit, publication receipt and both asset SHA-256 values). It is
  never imported into the Worker graph. A dependency update that changes the pin must update the
  record in the same reviewed change.
