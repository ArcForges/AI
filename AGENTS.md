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
- Run the documented checks for the affected change. A successful deployment must consume the verified candidate without rebuilding and pass a real Workflow smoke test before it is recorded as a verified release.
