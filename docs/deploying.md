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

For local verification, use `npm exec -- wrangler login` to authorize the local Wrangler client, and set `CLOUDFLARE_ACCOUNT_ID` in the current terminal. The deployment script captures the OAuth credential internally without printing it. CI always uses the environment API token, never a copied OAuth refresh token. An account token can alternatively be injected into the local process by a secret manager.

## First real run

After source checks and a clean committed candidate are ready, run:

```sh
npm run check
npm run build
npm run test:bundle
npm run deploy
npm run test:live
```

The last two commands modify the selected Cloudflare account and consume model usage. The smoke name is the non-sensitive string `ArcForges`. A successful run makes two bounded model calls and one local greeting tool call. It proves that the deployed Workflow, selected model, Responses adapter and published protobuf package interoperate. It does not verify product authorization, billing, streaming, R2 or full AI task execution.

Inspect `artifacts/deployment/`: `intent.json` records the attempted upload, `deployment.json` records its confirmed Worker version and the stable smoke ID, `live-state.json` records progress, and `live-evidence.json` is written only after full live validation. Evidence must match the candidate's source commit, build version and native Worker version metadata. The model's greeting may vary; the tool result and provenance must match exactly.

## Automatic main delivery

PR validation runs without Cloudflare credentials. Merging to `main` performs the following sequence:

1. Validate source on Linux and Windows, dependencies, secrets and CodeQL.
2. Build a candidate once on Linux, verify hashes and execute that compiled bundle locally with explicit model mocks.
3. Require the aggregate **Verify** check to pass.
4. Download that candidate by its GitHub artifact ID, verify its source and files, and deploy it with `--no-bundle` through the `cloudflare` environment.
5. Run the real Workflow smoke test and publish its evidence. Only a successful live test creates the `ai-0.1.0-ci.<run>.<attempt>` GitHub prerelease with the deployable candidate.

The candidate contains the bundle/configuration, file hashes, source identity, Contracts provenance, runtime SBOM and licenses. It is not published to npm. The same artifact is consumed by deployment; no dependency resolution or recompilation changes its Worker code. Installing the pinned CLI in the deployment job is tooling setup only.

Deployment jobs serialize access to the account. A superseded main run cannot intentionally redeploy an older commit through CI. A failed deployment may still have updated Cloudflare; the GitHub job must remain red until the live gate passes. Deployment-state artifacts are uploaded even after failure.

## Failure and recovery

- **Credential/permission/model access failure:** correct the account or GitHub setting, then rerun the failed job. Do not change code to return a fake result or disable required verification.
- **Workflow status query fails or times out:** retain the candidate and `artifacts/deployment/`, then rerun `npm run test:live`. It queries the same `hello-<worker-version>` instance; if a previous create response was lost, an existing instance is read without a new POST. Never restart an errored instance automatically. The `submitting` record preserves the chosen ID before the POST.
- **Model call fails:** model steps have zero automatic retries. Inspect the failed instance in Cloudflare. Starting a new deployment/run is an explicit new attempt and may incur additional usage. A step timeout cannot prove that the provider stopped processing the dispatched request.
- **Upload confirmation is lost:** inspect `intent.json` and the Cloudflare Worker version list before uploading again. The script does not claim a confirmed deployment without Wrangler's version ID. Restore a confirmed deployment record only from observed Cloudflare metadata, not guessed values.
- **Regression after deployment:** select a previously verified GitHub candidate, inspect its manifest and restore that artifact. In a local checkout of its matching source, restore the candidate into `artifacts/candidate/`, verify it, deploy it and run a new live test. This creates a new confirmed Worker version from the old verified bytes. Existing Workflow instances keep their own execution state; a Worker rollback is not a transaction rollback or an automatic restart of those instances.

Do not overwrite an existing GitHub release with different artifacts. To release a changed candidate, use a new main commit/run. The private Hello Agent has no automatic triggers, so a deployed but failed smoke does not create an open public inference service.

## References

- [Workers GitHub Actions deployment](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
- [Workflow instance creation](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/create/)
- [Workflow status](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/get/)
- [GPT-OSS Responses support](https://developers.cloudflare.com/changelog/post/2025-08-05-openai-open-models/)

The pinned Wrangler trigger implementation sends an object in `params`, as the Workflow event expects. The current REST reference labels that field a JSON string; this implementation follows the shipping CLI and does not double-encode the payload. Actual service behavior remains part of the live gate.
