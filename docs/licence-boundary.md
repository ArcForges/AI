# Project licence boundary (WP00.02)

The AI owner uses AGPL-3.0-only / AGPL for its original source and tooling, under
the accepted [Design profile](https://github.com/ArcForges/ArcForges-Design/blob/6ba885ad38dd71de532c74d7b69f439d01d19a0a/docs/architecture/01-solution-and-project-layout.md#41-project-declaration-and-verification-profile).
The root npm project declares both `license` and `arcforges.licenceBoundary`;
`eng/policy/licence-boundary.json` registers every current project manifest.

Both `npm run check` and candidate construction check the actual Git inventory,
effective npm metadata and dependency graph. Missing/inconsistent declarations,
unregistered build scopes, unpublished source references and unknown first-party
packages (including aliases and transitive lock entries) fail. Negative tests run
against temporary Git repositories. This check does not relicense dependencies;
existing candidate license texts and notices remain required.

`artifacts/evidence/licence-boundary.json` records the source commit, dirty state,
project declarations, dependency edges and findings. CI retains it separately from
the candidate. Existing source tests, bundle/Workflow tests and immutable delivery
gates continue to apply. Local model fixtures remain mocked inference; only the
post-merge Cloudflare Workflow smoke can establish the actual deployment and model
result. No product capability, account permission or commercial gate closes from a
licence declaration.
