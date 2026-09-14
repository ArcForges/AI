# Validation evidence

This file records the bootstrap's verification boundaries. Update it with observed results, never inferred passes.

| Gate                             | Current evidence                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependencies                     | Pinned Node 24.21.0/npm 11.19.0 installation completed with lifecycle scripts disabled; initial npm audit reported zero vulnerabilities           |
| Source and local Workflow        | 21 tests passed with explicit model mocks; current types passed                                                                                   |
| Compiled artifact                | The actual Wrangler bundle executed locally; its Workflow and protobuf tool passed with model-step fixtures                                       |
| Final repository checks          | Formatting, recommended Biome rules, TypeScript checks, 21 runtime tests, 7 release-tool tests, bundle verification and actionlint passed locally |
| GitHub CI                        | Pending branch push and PR validation                                                                                                             |
| Cloudflare account/configuration | Pending user-owned account setup                                                                                                                  |
| Real deployment and inference    | Not performed; no live verification is claimed                                                                                                    |

Local tests cannot establish model availability, token permissions, actual provider Responses compatibility, quotas or billing. The live gate must produce `artifacts/deployment/live-evidence.json` from the deployed version and source before release success is claimed. GitHub prereleases are created only after that gate passes on main.
