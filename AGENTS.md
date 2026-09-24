# Repository instructions

- Read README and the relevant development/deployment guide before making changes. Keep code, comments and repository documents in English.
- Use a separate Git worktree and branch. Keep the primary checkout and other ArcForges repositories unchanged.
- Collect the relevant problems, decide a bounded plan, then implement and validate it. Do not expand a Hello World task into product behavior.
- Preserve the repository's AGPL-3.0-only license. Third-party dependencies retain their licenses and notices.
- Consume published Contracts packages with exact versions and the committed lockfile. Do not use submodules, sibling source imports or copied generated contracts.
- The AI loop belongs to Cloudflare Workflows. Use the Workers AI binding directly. Cloud business authority, permissions, balances and transactions do not move into this repository.
- PR checks are credential-free. Local model-step fixtures are mocks, never evidence of real inference. Keep real deployment/model evidence separate.
- Never commit, print or upload API tokens, OAuth credentials or local secret files. Do not expose the private demo Worker through routes, workers.dev or preview URLs.
- Follow the user's authorization for remote operations. When Cloudflare setup is missing, complete account-independent work and stop for account configuration.
- Run the documented checks for the affected change. Deployment consumes the checked candidate without rebuilding and records provider completion; it must not trigger a Workflow or inference test.

## Delivery model (P2-018)

Work is scheduled as delivery tasks in the [delivery graph](https://github.com/ArcForges/ArcForges-Design-B/blob/fd16c5f285de0bda2d0320cdff4d52c34c9098ed/docs/planning/delivery/README.md) and executed through the [Plan execution entry](https://github.com/ArcForges/Plan-B/blob/0cb637d1bfbf64d7db22a96a2b7370a409a25d8e/arcforges-implementation.md). There is no Current task, numbered substep order or single main context.

- Baseline: The accepted bootstrap is the bounded Hello Worker and Workflow scaffolding with the WP02 build, dependency and provenance baselines; it is not Harness behavior. Every Harness and routing capability is an open task. This repository's tasks are in the [harness](https://github.com/ArcForges/ArcForges-Design-B/blob/fd16c5f285de0bda2d0320cdff4d52c34c9098ed/docs/planning/delivery/lanes/harness.md), [ai-routing](https://github.com/ArcForges/ArcForges-Design-B/blob/fd16c5f285de0bda2d0320cdff4d52c34c9098ed/docs/planning/delivery/lanes/ai-routing.md) lanes and parts of the extensions and governance lanes.
- Start only a task that Plan-B's `python tools/delivery.py ready --claims` lists and whose `claims/<task-id>` branch you hold. A task here becomes ready only after the adoption slice for its lane (`ADOPT.08.<lane>`) is recorded.
- Several workers may work here at once, each on a different claimed task in its own retained worktree and `task/<task-id>` branch, inside the task's write scope. Harness tasks add their steps through their own modules, so context, output, recovery and routing work proceed in parallel.
- Shared files follow their [declared protocols](https://github.com/ArcForges/ArcForges-Design-B/blob/fd16c5f285de0bda2d0320cdff4d52c34c9098ed/docs/planning/delivery/shared-resources.md): the Workflow entry is owned by the turn-loop task and other Harness tasks add steps through their own modules; the model route-pin table changes only with a policy snapshot; the AI deployment environment is held through a short lease during live runs. The AI integration owner orders merges and merges only pull requests of the claimant at the current claim epoch.
- Title pull requests `[<TASK-ID>] <summary>`; a bundle of compatible ready tasks lists each ID, and planning alignment uses `[P2-018]`.
- Earlier dated bootstrap and validation records under `docs/` describe their original scope; they are evidence, not execution instructions.

## Required validation limits

Follow [validation policy](docs/validation-policy.md), which supersedes older runtime and release-test requirements. Never add or execute macOS CI, device/emulator/GUI/browser E2E CI, live service or inference CI, installed-consumer CI or public-download verification. Keep runtime checks explicit local opt-in. Do not repeat public archive/hash checks, passing tests or post-merge runtime cycles. Preserve lock/signature/licence/provenance checks at actual trust handoffs. Do not invoke wsl.exe, configure proxy 7890 or install toolchains solely for testing. Stop and report the exact failed network operation. Hooks do not rebuild/test on commit or push.

Dependency additions and upgrades follow [the enforced admission policy](docs/dependency-policy.md); update its input-bound review and retain the existing class and provenance gates.
