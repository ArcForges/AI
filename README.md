# ArcForges AI

ArcForges' AI execution runtime on Cloudflare Workers and Workflows. The repository currently contains a private Hello Agent: a selected Workers AI model calls one validated greeting tool, then writes a final reply. The greeting tool uses the published ArcForges protobuf package.

The intended product architecture keeps the only model/tool loop in a Workflow. Cloud owns business authorization, PostgreSQL transactions, approvals and accounting. This bootstrap demonstrates the runtime, package boundary, build and deployment path; it does not implement the full product harness, streaming, R2 routes or commercial behavior.

## Quick start

Install Node **24.21.0 LTS** with npm **11.19.0**, then:

```sh
npm ci --ignore-scripts
npm run hooks
npm run check
npm run build
npm run test:bundle
```

These commands need no Cloudflare account. Both Workflow tests and the bundled Worker test explicitly mock the two model steps; the pure protobuf tool and local Workflow engine execute normally. The build produces `artifacts/candidate/`, including the deployable bundle, configuration, hashes, provenance, licenses and runtime SBOM.

The toolchain pins TypeScript **7.0.2**, Wrangler **4.131.2** and `@arcforges/proto` **1.0.0-ci.25.1**. See [development](docs/development.md) for tool compatibility, local health testing and dependency updates.

## Hello Agent

1. Validate `{ "name": "ArcForges" }` before admitting a model call.
2. Ask `@cf/openai/gpt-oss-20b` for exactly one `say_hello` function call using the model's Chat Completions binding profile.
3. Validate the tool and its arguments, then encode/decode the published request and response protobuf messages to produce `Hello, ArcForges!`.
4. Supply that result to the model and require a bounded final text reply with no further tools.

Each model step disables automatic retries and allows at most 1,024 output tokens with a 90-second step timeout. Names are limited to 80 Unicode code points and 256 UTF-8 bytes, with no ASCII control characters. Whitespace and Unicode are preserved. Unsupported tools, changed arguments and incomplete/malformed model output fail the Workflow.

The Worker has no public route, workers.dev URL or preview URL. Remote runs are started and inspected through Cloudflare's authenticated Workflow API. The local `GET /health` handler reports the build identity; it does not call a model or prove inference.

## Delivery

PRs validate source, dependencies, the local runtime and the final bundle on GitHub. A merge/push to `main` automatically deploys the verified candidate from that run, starts a guarded Workflow that checks its own deployment identity before either model call, performs a real model/tool/model smoke test, and creates a GitHub prerelease with the candidate and deployment evidence. Only an instance proven to have rejected the request before any model call may be replaced while waiting for deployment admission. Failed or uncertain model execution and missing deployment settings fail the gate; no automatic model fallback is used.

This is a deployable Worker, not an npm library. Versions are automatic: `0.1.0-ci.<run-number>.<run-attempt>`. No manual version edit, npm account, NuGet key or PGP key is needed.

Before the first merge, complete [Cloudflare setup and deployment](docs/deploying.md). That guide covers account settings, the GitHub `cloudflare` environment, live verification and recovery. [Validation evidence](docs/validation.md) distinguishes completed local checks from pending external gates.

## Repository guide

- [Bootstrap plan](docs/bootstrap-plan.md)
- [Development and hooks](docs/development.md)
- [Project licence declarations and checks](docs/licence-boundary.md)
- [Cloudflare setup, release and recovery](docs/deploying.md)
- [Contributing](CONTRIBUTING.md), [conduct](CODE_OF_CONDUCT.md) and [security](SECURITY.md)
- [AGPL-3.0-only license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md)
