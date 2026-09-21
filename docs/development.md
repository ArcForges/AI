# Development

## Toolchain

| Component                          | Pinned version         | Reason                                                                          |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| Node / npm                         | 24.21.0 / 11.19.0      | Current LTS line shared with Contracts                                          |
| TypeScript                         | 7.0.2                  | Current release checked on 2026-09-14                                           |
| Wrangler                           | 4.135.0                | Worker bundling, deployment and local test harness                              |
| Workers types                      | 5.20260918.1           | Current binding and model input/output types                                    |
| Cloudflare Vitest plugin           | 1.1.13                 | Local Workerd/Workflow integration                                              |
| Vitest                             | 4.1.11                 | Plugin requires Vitest 4.1; latest Vitest 5 is not a compatible upgrade         |
| Biome / Prettier                   | 2.5.14 / 3.9.8         | Lint/format without depending on the removed TypeScript JavaScript compiler API |
| ArcForges proto / protobuf runtime | 1.0.0-ci.44.1 / 2.15.0 | Published Contracts messages, not sibling source                                |

`npm ci --ignore-scripts` restores the committed dependency graph on Windows and Linux without lifecycle scripts. The selected tools work with this installation mode. `package-lock.json` includes transitive/platform packages for reproducibility; do not shorten it by hand. Platform-independent source checks run once on Linux CI; no Windows duplicate or macOS job is required.

## Commands

| Command               | Result                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------- |
| `npm run hooks`       | Enables this worktree's pre-commit and pre-push hooks                                  |
| `npm run format`      | Formats repository text; generated bindings and npm's lockfile are excluded            |
| `npm run types`       | Regenerates the small binding declaration from Wrangler config                         |
| `npm run check`       | Repository policy, formatting, lint, type checks, pure offline units and tooling tests |
| `npm run build`       | Offline dry-run bundle and hash-verified candidate under `artifacts/candidate/`        |
| `npm run test:bundle` | Optional local final-bundle runtime with explicit model-step mocks                     |
| `npm run deploy`      | Uploads the verified candidate using Cloudflare credentials; does not rebuild          |
| `npm run test:live`   | Optional local diagnostic; never run by CI                                             |

Hooks only check whitespace; they do not rebuild, test, deploy or call a model. They configure `core.hooksPath` for the current worktree, leaving other worktrees' hook choices intact. Applicable CI checks remain authoritative.

To inspect the local health response, run `npm run dev -- --remote-bindings=false`, then request `http://localhost:8787/health`. That handler returns build metadata only. The default AI binding is remote when enabled; real invocation consumes Workers AI usage even from local development. The test configuration explicitly disables remote bindings, and the compiled-bundle harness omits the remote AI binding entirely.

## Dependency and contract changes

Update exact versions with `npm install --save-exact <package>@<version>` or `--save-dev` as appropriate, preserving `--ignore-scripts`. Review the manifest and lockfile together. Run the affected offline checks, one candidate build and the dependency audit. Bundle/Workflow runtime diagnostics remain explicit local opt-in under the validation policy. A binding/toolchain update also requires regeneration and review of `src/env.generated.d.ts`.

Keep the Cloudflare plugin, Wrangler and Vitest updates in a compatible group. Dependabot does not independently propose a Vitest major upgrade; review that upgrade explicitly when the Cloudflare plugin supports it. Keep `@arcforges/proto` and `@bufbuild/protobuf` compatible with the published Contracts manifest. No package can float to a different implementation between candidate testing and deployment.

`npm run test:tooling` runs offline policy tests without a candidate build. `test:artifact` is an explicit packaging investigation, not part of normal checks. `npm test` runs only the pure hello/model/diagnostic units using Node; the Cloudflare plugin is loaded only by `vitest.runtime.config.ts`. See [validation policy](validation-policy.md).

Local candidates built with uncommitted changes declare `sourceDirty: true` and can be tested but cannot be deployed. Commit the reviewed source and rebuild to obtain a candidate whose provenance identifies the exact source tree.

## Test boundaries

`tests/model.test.ts` checks the Chat Completions request/response adapter with a fake AI binding, including the named-function choice and string content required when replaying a tool call. `npm run test:runtime` explicitly selects `tests/workflow.test.ts`, which uses a real local Workflow engine while mocking model steps; the protobuf tool executes. It also verifies durable admission in the actual inference instance, zero-model rejection of stale identities, and the version check inside each model step even when a replayed admission was accepted. `eng/tests/` verifies candidate integrity, strict version/admission provenance, bounded selection after proven pre-model rejection, and safe resumption after lost create responses. Unknown failures, model-step history and an independent successful probe cannot authorize a replacement. `npm run test:bundle` runs the actual compiled entry point: a stale guarded inference request must be rejected without an AI binding, while an accepted request executes the real tool with explicit model-step fixtures.

Negative Workflow tests intentionally exercise invalid inputs and model errors. Workerd may log those injected errors even when the assertions pass. Unexpected errors fail that optional local invocation. Real provider compatibility, quotas and latency are untested by CI; no live gate is added.

Model diagnostics are shared with the Node 24 tooling through its native TypeScript type stripping; the codec has no runtime dependencies or transform-only TypeScript syntax. Regression tests distinguish response validation from provider failures, verify both calls pin their sampling parameters, preserve diagnostics across local Workflow error serialization, redact remote text, and prevent retries after either model step fails. A successful mock or small set of real samples cannot establish a model's failure rate.
