# Cloudflare deployment and verification

## One-time setup

1. Sign in to the Cloudflare account that will own `arcforges-ai-hello`. Workers, Workflows and Workers AI must be available on that account. The selected model is `@cf/openai/gpt-oss-20b`. Accept any account/model terms shown by Cloudflare yourself; do not treat a local mock as proof of access.
2. Copy that account's **Account ID**. This is not a Zone ID, email address or API token. No domain, R2 bucket or public workers.dev route is needed for this private Hello Agent.
3. Create a scoped API token under **My Profile > API Tokens**. Grant **Account / Workers Scripts / Edit**, **Account / Workers AI / Read** and **Account / Workers AI / Edit**, limited to this one account. Workflow management uses Workers Scripts permission. Avoid the Global API Key and unrelated DNS/zone permissions. Choose an expiry appropriate to your rotation policy; update the GitHub secret before it expires.
4. In [AI repository environments](https://github.com/ArcForges/AI/settings/environments), use the **cloudflare** environment. It is repository-specific. Restrict deployments to the `main` branch. Add the following values; do not paste the token into chat or source files.

| Kind                 | Name                    | Value                                  |
| -------------------- | ----------------------- | -------------------------------------- |
| Environment variable | `CLOUDFLARE_ACCOUNT_ID` | The 32-character Cloudflare Account ID |
| Environment secret   | `CLOUDFLARE_API_TOKEN`  | The scoped token value                 |

There is no publish enable/disable variable and no npm/NuGet credential. Missing settings produce a failing deployment with a clear error, instead of a green skipped publication. Do not add a required environment reviewer if every successful main merge should deploy automatically.

The bootstrap uses the account plan's default CPU limits. Do not add `limits.cpu_ms` for a Workers Free account: Cloudflare rejects custom CPU limits on that plan, even when the requested value equals the Paid default. Free Workflows have a 10 ms CPU limit per step; time waiting for the model response is not CPU time. The two model steps still enforce their separate 90-second timeout, 1,024-output-token limit and zero automatic retries. A successful Hello run does not establish capacity for a production workload. See [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/).

For local verification, use `npm exec -- wrangler login` to authorize the local Wrangler client, and set `CLOUDFLARE_ACCOUNT_ID` in the current terminal. The deployment script captures the OAuth credential internally without printing it. CI always uses the environment API token, never a copied OAuth refresh token. An account token can alternatively be injected into the local process by a secret manager.

The API token and browser-authorized OAuth credential have their own permissions and lifetime. Either can authorize the same deployment/Workflow-management operation when scoped appropriately. The deployed Workflow calls `env.AI` through its Workers AI binding; it does not receive the GitHub token as a model parameter or runtime secret. A completed deployment/admission followed by an adapter response-validation error is not evidence that the CI token needs replacement or broader permissions.

## First real run

After source checks and a clean committed candidate are ready, run:

```sh
npm run check
npm run build
npm run test:bundle
npm run deploy
npm run test:live
```

The last two commands modify the selected Cloudflare account and consume model usage. The smoke submits a guarded request to the actual inference instance:

```json
{
  "kind": "verified-hello",
  "expected": {
    "workerVersion": "<confirmed Worker version UUID>",
    "sourceCommit": "<candidate source commit>",
    "buildVersion": "<candidate version>"
  },
  "hello": { "name": "ArcForges" }
}
```

That same instance persists an `admit-deployment` decision before any AI step. The native Worker version, source commit and build version must all match. A mismatch completes with `deployment-rejected`, zero model calls and only the admission step. Acceptance is durable: replay cannot turn a previously accepted decision into a model-free rejection. Each model callback checks its current identity again immediately before calling AI; an identity change after admission fails the instance without automatically replacing it.

An independent readiness probe cannot establish which Worker another instance will run. The CLI no longer creates one. It may select another guarded instance only after reading complete proof of rejection before AI: either the structured rejection plus exactly one successful admission step, or the known older-runtime invalid-input error plus zero steps. Older bootstrap code rejects this shape because it has no top-level `name`. Missing history, unexpected errors, a pending instance or any possible model execution never authorize another ID.

Selection is bounded to 30 deterministic IDs within a five-minute polling window: `hello-<worker-version>`, then `hello-<worker-version>-2` through `-30`. Each ID is read before creation and recorded before POST. If a response is lost, the invocation stops; resumption reads that same ID. A valid admitted instance makes two bounded model calls and one local greeting tool call. The final output must still match the full deployment identity and its persisted admission. This proves the deployed Workflow, selected model, adapter and published protobuf tool interoperate; it does not verify product authorization, billing, streaming, R2 or full task execution.

Use the selected model's Chat Completions binding profile: `messages`, a named-function `tool_choice`, `max_tokens` and `reasoning_effort`. The follow-up includes an assistant tool-call message with `content: ""` and a tool message with the same call ID. Live checks on 2026-09-14 found that forced-tool Responses requests returned Workers AI error 3030, while equivalent Chat Completions requests succeeded; replaying `content: null` was rejected with error 5006. The adapter accepts exactly one structured tool call and a final `stop` response. It does not recover tool calls from prose, retry a different protocol or switch models after failure.

Both model requests explicitly set `temperature: 0`, instead of inheriting the model's documented default of 0.6. This reduces sampling variability for the Hello contract smoke; it cannot guarantee deterministic output or eliminate provider faults. The named function, strict argument validation, low reasoning effort, 1,024-output-token budget and zero automatic model retries remain enforced. A truncated response, refusal, malformed/multiple tool call or unexpected finish reason still fails the live gate.

Model errors use a shared `AF_MODEL_FAILURE_V1` diagnostic codec. Response errors identify the phase and failed check, with an allowlisted finish reason/role, choice/tool counts, content length, refusal/legacy flags and completion-token count when returned. Binding exceptions report a known error type and numeric status/code when available. Raw prompts, response text, reasoning, tool arguments and arbitrary exception messages are excluded. The CLI includes these safe fields, the failed step and attempt count in its error and deployment evidence. Unknown platform errors retain safe step context without inventing a provider cause. `modelUsage: "possibly-incurred"` is not a billing measurement; `"unknown"` does not mean zero usage.

Inspect `artifacts/deployment/`: `intent.json` records the attempted upload, `deployment.json` records its confirmed Worker version, base smoke ID and `verified-hello-v1` protocol, `admission/` retains each guarded instance's observed state and rejection reason, `live-state.json` records progress, and `live-evidence.json` is written only after full live validation. Evidence must match the candidate's source commit, build version and native Worker version metadata. The model's greeting may vary; the tool result and provenance must match exactly.

## Automatic main delivery

PR validation runs without Cloudflare credentials. Merging to `main` performs the following sequence:

1. Validate source on Linux and Windows, dependencies, secrets and CodeQL.
2. Build a candidate once on Linux, verify hashes and execute that compiled bundle locally with explicit model mocks.
3. Require the aggregate **Verify** check to pass.
4. Download that candidate by its GitHub artifact ID, verify its source and files, and deploy it with `--no-bundle` through the `cloudflare` environment.
5. Run the guarded Workflow smoke test with admission inside each actual instance and publish its evidence. Only a successful live test creates the `ai-0.1.0-ci.<run>.<attempt>` GitHub prerelease with the deployable candidate.
6. Require **Verify deployment** to observe a successful deployment job. An unexpectedly skipped deployment cannot leave a non-cancelled main run green.

**Dependency review** compares a PR's dependency changes and intentionally skips on push. **Verify** accepts that skip outside PRs, while still requiring every applicable validation gate to pass. Deployment uses an explicit `!cancelled()` status condition and requires successful Verify and candidate results, so the PR-only job cannot suppress deployment through GitHub's implicit `success()` condition. PR, manual and scheduled runs do not deploy.

The candidate contains the bundle/configuration, file hashes, source identity, Contracts provenance, runtime SBOM and licenses. It is not published to npm. The same artifact is consumed by deployment; no dependency resolution or recompilation changes its Worker code. Installing the pinned CLI in the deployment job is tooling setup only.

Deployment jobs serialize access to the account. A superseded main run cannot intentionally redeploy an older commit through CI. A failed deployment may still have updated Cloudflare; the GitHub job must remain red until the live gate passes. Deployment-state artifacts are uploaded even after failure.

## Failure and recovery

- **Main deployment unexpectedly skipped:** inspect the workflow conditions, not an enable variable. After a workflow fix, merge it and inspect the new main run; rerunning the old run uses its old workflow revision. The final deployment check reports an unexpected skip as failure.
- **Admission limit reached:** retain the admission records and inspect the rejected instances. This message is emitted only after proven pre-model rejections. Run `npm run test:live` again to read the same deterministic IDs and use remaining IDs; it cannot exceed 30 IDs for that deployment. If every ID was rejected, inspect the cause before making a new deployment. A running instance instead produces a timeout naming that instance, with no claim of zero model calls.
- **Real output identifies another Worker/candidate:** keep the job failed and preserve that completed instance. Retrying the same smoke reads its existing output; it cannot turn into a new-version execution. A reviewed new deployment is a separate attempt. Do not weaken version checks or automatically run replacement model calls.
- **Credential/permission/model access failure:** correct the account or GitHub setting, then rerun the failed job. Do not change code to return a fake result or disable required verification.
- **Workflow status query fails or times out:** retain the candidate and `artifacts/deployment/`, then rerun `npm run test:live`. It reads the deterministic IDs in order, advancing only past proven pre-model rejections to the same admitted or uncertain instance. If a previous create response was lost, an existing instance is read without a new POST. Never restart an instance whose model may have run. The `submitting` record preserves the chosen ID before the POST.
- **Legacy smoke record:** records without `smokeProtocol: "verified-hello-v1"` cannot start this guarded smoke. Inspect their original instances using the matching old tooling; do not add the protocol marker by hand. A reviewed deployment of a guarded candidate is a separate attempt.
- **Model call or response validation fails:** inspect `failure` in `live-state.json` and the matching `admission/<run-id>.json`. `PROVIDER_CALL_FAILED` distinguishes a binding exception from `FINISH_REASON`, `OUTPUT_TRUNCATED`, `REFUSAL` and other adapter checks. A legacy generic response error cannot reveal which field failed; do not infer that from a later success. Model steps have zero automatic retries. Starting a new deployment/run is an explicit new attempt and may incur additional usage. A step timeout cannot prove that the provider stopped processing the dispatched request. Retrying `test:live` reads the same failed instance; rerunning the GitHub deployment job uploads a new Worker version and creates a separate smoke instance, even if it reuses the original candidate.
- **Upload confirmation is lost:** inspect `intent.json` and the Cloudflare Worker version list before uploading again. The script does not claim a confirmed deployment without Wrangler's version ID. Restore a confirmed deployment record only from observed Cloudflare metadata, not guessed values.
- **Regression after deployment:** select a previously verified GitHub candidate, inspect its manifest and restore that artifact. In a local checkout of its matching source, restore the candidate into `artifacts/candidate/`, verify it, deploy it and run a new live test. This creates a new confirmed Worker version from the old verified bytes. Existing Workflow instances keep their own execution state; a Worker rollback is not a transaction rollback or an automatic restart of those instances.

Do not overwrite an existing GitHub release with different artifacts. To release a changed candidate, use a new main commit/run. The private Hello Agent has no automatic triggers, so a deployed but failed smoke does not create an open public inference service.

## References

- [Workers GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Workflow instance creation](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/create/)
- [Workflow status](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/get/)
- [Selected GPT-OSS model and binding usage](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)

The pinned Wrangler trigger implementation sends an object in `params`, as the Workflow event expects. The current REST reference labels that field a JSON string; this implementation follows the shipping CLI and does not double-encode the payload. Actual service behavior remains part of the live gate.
