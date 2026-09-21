# ArcForges AI

ArcForges' AI execution runtime on Cloudflare Workers and Workflows. The repository currently contains a private Hello Agent: a selected Workers AI model calls one validated greeting tool, then writes a final reply. The greeting tool uses the published ArcForges protobuf package.

The intended product architecture keeps the only model/tool loop in a Workflow. Cloud owns business authorization, D1 transactions, approvals and accounting under the [current runtime authority](https://github.com/ArcForges/ArcForges-Design/blob/e2dd78058ce2d4bd1a8434a34d049bbc1158eacb/docs/architecture/30-runtime-and-source-ownership-policy.md). This bootstrap demonstrates the runtime, package boundary, build and deployment path; it does not implement the full product harness, streaming, R2 routes or commercial behavior.

## Quick start

Install Node **24.21.0 LTS** with npm **11.19.0**, then:

```sh
npm ci --ignore-scripts
npm run hooks
npm run check
npm run build
```

These commands need no Cloudflare account. Default tests run pure offline units in Node. Workflow engine and bundle runtime tests are separate explicit local opt-in commands, never CI gates. The build produces `artifacts/candidate/`, including the deployable bundle, configuration, hashes, provenance, licenses and runtime SBOM.

The toolchain pins TypeScript **7.0.2**, Wrangler **4.131.2** and `@arcforges/proto` **1.0.0-ci.25.1**. See [development](docs/development.md) for tool compatibility, local health testing and dependency updates.

## Hello Agent

1. Validate `{ "name": "ArcForges" }` before admitting a model call.
2. Ask `@cf/openai/gpt-oss-20b` for exactly one `say_hello` function call using the model's Chat Completions binding profile.
3. Validate the tool and its arguments, then encode/decode the published request and response protobuf messages to produce `Hello, ArcForges!`.
4. Supply that result to the model and require a bounded final text reply with no further tools.

Each model step disables automatic retries and allows at most 1,024 output tokens with a 90-second step timeout. Names are limited to 80 Unicode code points and 256 UTF-8 bytes, with no ASCII control characters. Whitespace and Unicode are preserved. Unsupported tools, changed arguments and incomplete/malformed model output fail the Workflow.

The Worker has no public route, workers.dev URL or preview URL. Remote runs are started and inspected through Cloudflare's authenticated Workflow API. The local `GET /health` handler reports the build identity; it does not call a model or prove inference.

## Delivery

PRs validate source, targeted offline units, dependencies/security and the sealed Worker build. Main deploys that same candidate and creates a prerelease containing the candidate and provider deployment record. CI does not invoke a Workflow or model, test the compiled runtime, poll health or download public release bytes. Deployment completion is distinct from live runtime acceptance. See [validation policy](docs/validation-policy.md).

This is a deployable Worker, not an npm library. Versions are automatic: `0.1.0-ci.<run-number>.<run-attempt>`. No manual version edit, npm account, NuGet key or PGP key is needed.

Before the first merge, complete [Cloudflare setup and deployment](docs/deploying.md). That guide covers account settings, the GitHub `cloudflare` environment, live verification and recovery. [Validation evidence](docs/validation.md) distinguishes completed local checks from pending external gates.

## Repository guide

- [Bootstrap plan](docs/bootstrap-plan.md)
- [Development and hooks](docs/development.md)
- [Project licence declarations and checks](docs/licence-boundary.md)
- [Reuse records and actual artifact provenance](docs/provenance.md)
- [Cloudflare setup, release and recovery](docs/deploying.md)
- [Contributing](CONTRIBUTING.md), [conduct](CODE_OF_CONDUCT.md) and [security](SECURITY.md)
- [AGPL-3.0-only license](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md)

Build candidates also carry the [WP02.04 build identity](docs/build-identity.md), sealed from independent source/producer/lock inputs.
