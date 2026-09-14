# Hello Agent bootstrap plan

## Collected inputs

- AI main starts at `010c5bef4f63a8052fc074e99d24fa6affde1c0c`, containing only the AGPL-3.0 license. Preserve this license and the primary checkout.
- Worktree: `.worktree/hello-agent`; branch: `codex/ai-hello-agent`.
- The accepted Design architecture puts the only model/tool loop in a Cloudflare Workflow, calling selected Workers AI models directly. Business authorization, transactions and metering remain in Cloud. No Node sidecar or Agents SDK chat loop is introduced.
- Contracts main is `1fb1dfaaaaa7a9f2f4c64a6e1c6a2b7de47d67b0`. The public npm Hello World artifact is `@arcforges/proto@1.0.0-ci.25.1`, with `@bufbuild/protobuf@2.14.1`.
- Registry and official documentation checked on 2026-09-14: TypeScript 7.0.2, Wrangler 4.131.2, Workers types 5.20260914.1, Cloudflare Vitest plugin 1.1.9. The plugin requires Vitest 4.1; use 4.1.11 rather than unsupported Vitest 5. Node 24.21.0 LTS and npm 11.19.0 match Contracts.
- At initial collection, the machine and repository had no discovered Cloudflare credentials or deployment settings. Real deployment/inference is a separate account-dependent gate.

## Implementation decisions

1. Build a private Worker exporting `HelloAgentWorkflow` and a local health handler. Disable workers.dev and preview URLs. Trigger and inspect remote runs through the authenticated Cloudflare Workflow API; no public demo token or new product API is needed.
2. Select `@cf/openai/gpt-oss-20b`, the accepted lower-latency text profile, using its Chat Completions binding profile. The current model types support this profile, and live compatibility checks selected it over the initially planned Responses profile. A bounded model/tool/model sequence requests one `say_hello` tool, validates its arguments, performs a published-protobuf round trip, then asks the model for the final greeting. Reject unsupported/multiple tools, calls serialized into prose, truncated responses and malformed/empty output. Each model step has zero automatic retries and a bounded timeout/output size. Never silently substitute a fake response in deployed code.
3. This is a packaging/runtime demonstration. It does not implement WP-52, Cloud business authority, approvals, billing, streaming or R2 object routes. Demo names/results are non-sensitive and small enough for Workflow checkpoints; they are not a product persistence contract.
4. Pin dependencies and commit npm's lockfile. Use TypeScript 7 for checking; Biome for lint and Prettier for formatting without relying on the retired TypeScript compiler JavaScript API.
5. Test validation and provider adaptation, real local Workflow execution with explicit mocked model steps, failure/no-retry behavior, published Contracts interoperability, and the final bundled Worker. Live verification requires a Cloudflare account and is never claimed from mocks.
6. CI validates Linux and Windows, checks dependencies/secrets/CodeQL, and creates one bundle plus manifest/checksums. A main-only protected deployment consumes that artifact without rebuilding, records the deployed version and runs a real Workflow smoke test. PR/manual validation uses no Cloudflare secrets.

## Execution order and closure

Implement repository/toolchain setup, then Workflow/provider/tool/tests, then candidate/deployment tooling and workflows. Run local checks, review the resulting diff and fix only demonstrated failures. Configure GitHub settings that do not require Cloudflare ownership. Pause for the user's Cloudflare setup before account-dependent actions. After real verification and green required CI, finalize the PR without merging it.

Closure evidence must separately identify local unit/runtime tests, bundled-artifact checks, GitHub checks, Cloudflare deployment and real model inference. Record any pending gate explicitly. Keep secrets out of source, logs, artifacts and PR text.

## Sources

- [Workers testing](https://developers.cloudflare.com/workers/testing/)
- [Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [Workflow test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- [Selected model](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [Cloudflare's current model adapter](https://github.com/cloudflare/ai/tree/main/packages/workers-ai-provider)
- [GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [TypeScript](https://www.typescriptlang.org/)

## Bounded implementation review

The source/runtime/bundle checks passed before final repository review. That review identified three packaging/tooling corrections: Biome's migration must not disable recommended rules, uncommitted builds must not claim deployable commit provenance, and the protobuf runtime's BSD-3-Clause notice must accompany the Apache notices. These corrections are implemented together with a supported-major constraint for Vitest updates. The remaining external gate is Cloudflare account setup and actual model inference, not more product scope.
