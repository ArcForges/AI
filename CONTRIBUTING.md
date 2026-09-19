# Contributing

Use an isolated worktree and branch, make a bounded change and open a pull request against `main`. Follow [AGENTS.md](AGENTS.md) and [development](docs/development.md).

Install the pinned Node/npm versions, run `npm ci --ignore-scripts`, then opt in to the repository hooks with `npm run hooks`. Run `npm run check`, `npm run build` and `npm run test:bundle` before pushing runtime or deployment changes. Regenerate bindings with `npm run types` after changing Wrangler configuration.

Pin exact direct dependency versions and update `package-lock.json` together with `package.json`. Dependabot proposes changes; it does not automatically merge them. Test major toolchain upgrades against the Cloudflare plugin's peer requirements before accepting them. Consume Contracts from the registry rather than another checkout.

Describe the problem, resulting behavior and concrete validation in the PR. Distinguish mocked runtime tests from real Cloudflare inference. Never include credentials or private prompts in issues, logs or artifacts. Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Contributions to original repository code and tooling are provided under the existing AGPL-3.0-only license. Preserve dependency licenses and notices. Adding a reference project's feature does not authorize copying its implementation or changing product scope.

Follow the [provenance process](docs/provenance.md) before reusing source, tests, legal text or generated resources. Source and actual candidate checks require complete reviewed records, immutable history and preserved full notices.
