# Validation evidence

This file records observed bootstrap results and their boundaries. The live record identifies the exact runtime commit; documentation-only updates do not imply another deployment.

| Gate                          | Evidence                                                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies                  | Pinned Node 24.21.0/npm 11.19.0 installation with lifecycle scripts disabled; the initial npm audit reported zero vulnerabilities                                                                                                        |
| Source and local Workflow     | Formatting, recommended Biome rules, TypeScript checks and 25 runtime tests passed; model calls were explicitly mocked                                                                                                                   |
| Compiled artifact             | The actual Wrangler bundle executed locally; its Workflow and published protobuf tool passed with model-step fixtures                                                                                                                    |
| Deployment tooling            | 10 release-tool tests, candidate integrity checks and actionlint passed                                                                                                                                                                  |
| GitHub CI                     | [Bootstrap PR checks](https://github.com/ArcForges/AI/pull/1/checks) passed: Linux/Windows, both CodeQL languages, dependency/secret checks and the compiled candidate. The first main run's deployment skip is recorded below.          |
| Cloudflare configuration      | Main-only GitHub cloudflare environment has the Account ID and token secret. The GitHub token successfully uploaded a Worker and invoked a real Workflow in run 34865236650; candidate identity failed as described below.               |
| Real deployment and inference | Passed on 2026-09-14: the deployed Workflow completed both model steps and the protobuf tool, each in one attempt, returning `Hello, ArcForges!`. Worker/source provenance matched; workers.dev and preview URLs were confirmed disabled |

## Real Workflow evidence

The sanitized [live record](evidence/hello-agent-2026-09-14.json) identifies:

- Runtime source: `025a41ed3ddd325b0fa86d84019f054f5124d887`.
- Worker version: `20ebe270-8336-496e-9828-07c20f391907`.
- Workflow instance: `hello-20ebe270-8336-496e-9828-07c20f391907`.
- Model: `@cf/openai/gpt-oss-20b`, using the direct Workers AI binding's Chat Completions profile.
- Completed steps: `request-tool-1`, `say-hello-1`, `finish-greeting-1`; one attempt each.

The original candidate, manifest, deployment record and `live-evidence.json` remain under the bootstrap `hello-agent` worktree's ignored `artifacts/` directory. The tracked record excludes account credentials, email and model reasoning. It records a real deployed Workflow, separately from diagnostic REST calls and local fixtures.

## Corrections established by live checks

Cloudflare rejected explicit `limits.cpu_ms` on Workers Free (100328). The configuration now uses plan defaults, while retaining the model timeout, output limit and zero automatic retries. One initial Workflow failed before any step with `Worker not found`; a separate deployment of the same verified bytes entered the Workflow normally. Failed instances were preserved and not automatically restarted. The precise cause of that initial platform error was not established.

Forced-tool Responses requests returned Workers AI 3030, while equivalent Chat Completions tool requests succeeded. Replaying an assistant tool call with null content was rejected with 5006; string content succeeded. The adapter and regression tests now use the verified request profile and reject multiple tools, tool-shaped prose, truncated output and refusals. No protocol/model fallback was introduced.

## Remaining delivery boundary

The first [main run 34863704092](https://github.com/ArcForges/AI/actions/runs/34863704092) passed validation but incorrectly skipped deployment. The PR-only dependency review was an intentionally skipped ancestor; the deployment condition inherited GitHub's implicit `success()` check. The corrected condition explicitly requires successful Verify and candidate results without inheriting that ancestor's skip. A final **Verify deployment** job rejects unexpected main deployment skips.

[Main run 34865236650](https://github.com/ArcForges/AI/actions/runs/34865236650) then deployed Worker `1e63ef69-a96b-4f18-a92d-ddebac2bcc0a` with source `e37cb8133305dd0fb6fb64c5a5b41822e68e225c` and build `0.1.0-ci.9.1`. Its immediately created smoke completed on old Worker `20ebe270-8336-496e-9828-07c20f391907`, with the old source/build identity. The strict gate correctly failed and no release was created.

Without another upload or configuration change, a separate diagnostic instance `diagnostic-1e63ef69-a96b-4f18-a92d-ddebac2bcc0a` completed at 2026-09-14T16:00:59Z with all three expected identities and real `Hello, ArcForges!` output. Both instances reported Workflow version `d351aef3-7b47-4e00-8d3e-28f876123e9f`. This establishes a propagation window after successful deployment; it does not establish Cloudflare's internal cause or a guaranteed propagation duration. The failed original instance remains unchanged.

The delivery fix therefore waits for model-free readiness before creating the single real inference instance. Its [real verification record](evidence/workflow-propagation-2026-09-14.json) identifies runtime source `d9c635e5f63032bcbc70a295bfafd755dd860114` and Worker `6fb4c24c-648b-4815-a497-20bdcfee1b28`: the first probe was rejected by the old runtime with zero steps; the second observed all expected identities with zero model calls; the subsequent real smoke completed both model steps and the tool once each. Worker, source and build identities all matched, and workers.dev/preview URLs remained disabled. This was a real local OAuth deployment of the committed candidate, separate from mocked tests. PR checks use no Cloudflare secret. A main run containing this fix still needs to pass the real Workflow gate and create the GitHub prerelease. The diagnostic success does not retroactively validate the failed CI run, and readiness alone is never model evidence.

This Hello run does not verify production authorization, budgets/accounting, abuse resistance, streaming, R2, load capacity or the complete product harness. A real model response is not evidence that those product capabilities exist.
