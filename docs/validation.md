# Validation evidence

This file records the bootstrap's verification boundaries. Update it with observed results, never inferred passes.

| Gate                             | Current evidence                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies                     | Pinned Node 24.21.0/npm 11.19.0 installation completed with lifecycle scripts disabled; initial npm audit reported zero vulnerabilities                                                                         |
| Source and local Workflow        | 21 tests passed with explicit model mocks; current types passed                                                                                                                                                 |
| Compiled artifact                | The actual Wrangler bundle executed locally; its Workflow and protobuf tool passed with model-step fixtures                                                                                                     |
| Final repository checks          | Formatting, recommended Biome rules, TypeScript checks, 21 runtime tests, 7 release-tool tests, bundle verification and actionlint passed locally                                                               |
| GitHub CI                        | Passed [CI run 34855661379](https://github.com/ArcForges/AI/actions/runs/34855661379): Linux/Windows, both CodeQL languages, dependency/secret checks, compiled candidate and Verify                            |
| Cloudflare account/configuration | Main-only GitHub cloudflare environment has the Account ID and token secret; local OAuth is authorized and the target account is Workers Free. The GitHub token itself still requires the first main deployment |
| Real deployment and inference    | Private Worker and Workflow uploaded; workers.dev and preview URLs confirmed disabled. Separate provider diagnostics succeeded with Chat Completions; full deployed Workflow verification is in progress        |

Local tests cannot establish model availability, token permissions, actual provider compatibility, quotas or billing. The live gate must produce `artifacts/deployment/live-evidence.json` from the deployed version and source before release success is claimed. GitHub prereleases are created only after that gate passes on main.
