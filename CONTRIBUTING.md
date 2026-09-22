# Contributing

Use an isolated worktree and branch, make a bounded change and open a pull request against `main`. Follow [AGENTS.md](AGENTS.md) and [development](docs/development.md).

Use the existing pinned Node/npm versions, run `npm ci --ignore-scripts`, then opt in to the repository hooks with `npm run hooks`. Run relevant offline checks once; the hosted candidate job builds the Worker. Local `test:runtime`, `test:bundle` and `test:live` are explicit diagnostics only under [validation policy](docs/validation-policy.md). Regenerate bindings with `npm run types` after changing Wrangler configuration.

Pin exact direct dependency versions and update `package-lock.json` together with `package.json`. Dependabot proposes changes; it does not automatically merge them. Test major toolchain upgrades against the Cloudflare plugin's peer requirements before accepting them. Consume Contracts from the registry rather than another checkout.

Describe the problem, resulting behavior and concrete validation in the PR. Distinguish offline units, optional local runtime observations and provider deployment completion. Never include credentials or private prompts in issues, logs or artifacts. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Contributions to original repository code and tooling are provided under the existing AGPL-3.0-only license. Preserve dependency licenses and notices. Adding a reference project's feature does not authorize copying its implementation or changing product scope.

Follow the [provenance process](docs/provenance.md) before reusing source, tests, legal text or generated resources. Source and actual candidate checks require complete reviewed records, immutable history and preserved full notices.

Dependency additions and upgrades follow [the enforced admission policy](docs/dependency-policy.md); update its input-bound review and retain the existing class and provenance gates.
