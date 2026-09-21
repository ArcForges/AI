# Validation evidence

Historical verification evidence. Current execution follows [validation policy](validation-policy.md); these recorded runs are not repeated CI or post-merge requirements.

This file records observed bootstrap results and their boundaries. The table summarizes the initial bootstrap; later corrections and their verification appear below. Each live record identifies its exact runtime commit; documentation-only updates do not imply another deployment.

| Gate                          | Evidence                                                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies                  | Pinned Node 24.21.0/npm 11.19.0 installation with lifecycle scripts disabled; the initial npm audit reported zero vulnerabilities                                                                                                        |
| Source and local Workflow     | Formatting, recommended Biome rules, TypeScript checks and 29 runtime tests passed; model calls were explicitly mocked                                                                                                                   |
| Compiled artifact             | The actual Wrangler bundle executed locally; its Workflow and published protobuf tool passed with model-step fixtures                                                                                                                    |
| Deployment tooling            | 14 release-tool tests, candidate integrity checks and actionlint passed                                                                                                                                                                  |
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

The earlier independent-probe approach passed one real local deployment, recorded in [historical propagation evidence](evidence/workflow-propagation-2026-09-14.json): runtime `d9c635e5f63032bcbc70a295bfafd755dd860114`, Worker `6fb4c24c-648b-4815-a497-20bdcfee1b28`. That observation is valid for that execution, but it did not prove another instance would use the same Worker.

[Main run 34867252042](https://github.com/ArcForges/AI/actions/runs/34867252042) disproved that assumption. Its probe completed at 16:15:25Z on expected Worker `7f4c392e-f0d8-40d0-989e-02a6340959cf`, source `438821d736e081cc57b11b20702403e5d7c82e98`, build `0.1.0-ci.11.1`. The actual inference started nine seconds later, yet completed on old Worker `6fb4c24c-648b-4815-a497-20bdcfee1b28`, source `d9c635e5f63032bcbc70a295bfafd755dd860114`, build `0.1.0-local`. Both reported Workflow version `e060629d-47fe-474f-a12d-1c4d58d3646e`. The active deployment was the new Worker at 100%; no intervening upload was observed. The sanitized [failed-run comparison](evidence/workflow-probe-race-2026-09-14.json) preserves these observations.

The implementation defect was treating a successful check in one instance as admission for another. The real request carried no expected identity and could call AI before the final provenance assertion failed. These observations do not identify Cloudflare's internal routing or caching cause; the API's Workflow version ID cannot substitute for native Worker metadata.

The current fix persists deployment admission inside the actual inference instance and rechecks identity inside both model callbacks. Only strict proof of a pre-model rejection permits a bounded next ID. Unknown errors, lost responses, possible model execution and inconsistent step history stop the run. Independent readiness probes have been removed. Local checks and real evidence for this guarded candidate are recorded separately below; historical successes do not validate either failed main run.

## Guarded candidate verification

The [guarded verification record](evidence/workflow-admission-2026-09-14.json) records a real local OAuth deployment on 2026-09-14, using the unchanged verified candidate from runtime commit `3a173697026b6f4d52a79b45f0acb9b0b4662329`:

- Worker `0b8f1762-37d0-477a-be97-308743f03726`, build `0.1.0-local`.
- `hello-0b8f1762-37d0-477a-be97-308743f03726` completed admission, both real model steps and the protobuf tool, each in one attempt. Its persisted admission and final output matched the deployed Worker, source and build, returning `Hello, ArcForges!`.
- A deliberately incorrect Worker target completed with `deployment-rejected`, zero model calls and exactly one successful admission step. The real native Worker identity matched this candidate.
- Before that deployment, the older runtime rejected the guarded payload with the known invalid-input error and zero steps. This confirms the supported transition path does not dispatch AI.
- workers.dev and preview URLs remained disabled. No model failure or completed stale model run was retried.

All 29 runtime tests and 14 release-tool tests passed locally, along with formatting, lint, TypeScript, generated-binding checks and final-bundle execution. Local model steps were explicitly mocked; the compiled bundle's stale-target rejection ran without an AI binding. These checks include the independent-probe counterexample, lost-response resumption, rejection after possible model execution, bounded admission and both pre-model version guards.

[Main run 34870236250](https://github.com/ArcForges/AI/actions/runs/34870236250) subsequently passed the guarded Workflow gate after PR #6 merged. This GitHub result is distinct from the local OAuth verification; PR checks use no Cloudflare secret.

## Intermittent model response and diagnostics

In [main run 34870686257](https://github.com/ArcForges/AI/actions/runs/34870686257), attempt 1 failed in `request-tool-1` after deployment admission succeeded. The actual error was `Expected a completed assistant message without refusal or legacy tools.` It was not another Worker-version mismatch or a reported permission denial. The failed step had one attempt, no persisted response output, and no later tool/final-model step. The old compound check combined finish reason, message shape, role, refusal and legacy-tool validation, so the exact failing field cannot be recovered from this record.

The user's attempt 2 succeeded with the same source commit `5e08d32d8923d6c0e6f4b5d0eb3cfd8712b708dd`, build `0.1.0-ci.15.1` and candidate manifest SHA-256. The GitHub token's last-update timestamp did not change. The rerun uploaded a new Worker version and started a new instance; it did not repair or replace the original failed instance's history. The intervening merge updated development-only Node types, with no model request or deployment-profile change. The [sanitized comparison](evidence/workflow-model-response-2026-09-14.json) preserves the observations and limits.

Six bounded diagnostic REST requests using the original tool-request adapter all returned a valid structured tool call. They did not reproduce the original failure and are not Workflow evidence. The original requests omitted temperature, inheriting the selected model's documented default of 0.6. The current mitigation explicitly sets zero for both calls and replaces ambiguous response errors with safe per-check diagnostics. This reduces sampling variability and makes a recurrence actionable; it does not establish that sampling caused the original response or guarantee future provider success. Strict tool/finish validation, version admission and the prohibition on automatic retries after possible model execution remain unchanged.

## Model diagnostics candidate verification

Runtime commit `5b16d309e0075e95f070e6ed2774c794d138b009` passed 56 runtime tests and 20 release-tool tests, formatting, lint, TypeScript checks and binding regeneration without a diff. The final compiled bundle passed its local Workflow checks with explicit model mocks. The regressions cover both model phases, malformed/truncated/refused responses, safe provider error metadata, Workflow error serialization, step/poll timeouts and no additional model calls or instance replacements after possible dispatch. Failed instances with opaque output no longer lose their actual error to premature JSON parsing.

The [real verification record](evidence/workflow-runtime-verification-2026-09-14.json) records a local OAuth deployment of that same clean, verified candidate on 2026-09-14. Worker `8e908d40-958d-454f-89f1-23a03cddf5f5` and instance `hello-8e908d40-958d-454f-89f1-23a03cddf5f5` passed admission, both real model calls and the protobuf tool, each in one attempt. The output matched the candidate's native Worker/source/build identity. workers.dev and preview URLs remained disabled.

The new CLI also queried the original failed instance once using GET only. It reported `LEGACY_RESPONSE_VALIDATION`, step `request-tool-1`, one attempt and possible model usage, without starting another instance or claiming to recover the missing response. This verifies the improved diagnosis against a real retained failure as well as the local fixtures. No automatic model retry was introduced. This change's GitHub main deployment remains a separate gate after merge; a single successful real Workflow does not prove a zero provider failure rate.

This Hello run does not verify production authorization, budgets/accounting, abuse resistance, streaming, R2, load capacity or the complete product harness. A real model response is not evidence that those product capabilities exist.
