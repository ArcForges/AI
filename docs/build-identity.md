# Build identity

WP02.04 seals `build-identity.json` in every candidate. Its nine independent axes come from `eng/version-sources.json`, the allocated application release, the exact published Contracts schema/descriptor receipt and npm lock. Missing future capability, format, storage, policy and extension producers are explicit; this Hello Workflow does not establish those product capabilities. Cloudflare Workflow durability is not an owned migration version. Package versions never substitute for the Contracts wire-schema version.

Build metadata records full Git source, dirty/local or CI state, actual run ID/attempt and URL, and source commit UTC timestamp. CI rejects wrong or dirty source and incomplete run identity. Promotion can verify the original candidate attempt after a job retry; it cannot substitute another run.

The sealed Worker configuration carries compact artifact/build metadata and the SHA-256 of the complete report in `BUILD_IDENTITY`. The private health response and successful Workflow output read that candidate binding. They do not read the verifier's current environment or create a public endpoint. The full dependency inventory remains in the candidate; a compact digest binds it without exceeding Worker variable limits. Direct unsealed `wrangler dev` explicitly reports null identity.

Candidate checks independently reconstruct expected metadata from source/producer/lock and trusted CI inputs, rejecting altered reports or runtime bindings even after outer hashes are recomputed. The actual final bundle is executed with explicit model-step mocks, checking private health and successful Workflow metadata. Merged-main live verification separately checks the actual deployed Workflow's identity after its existing guarded two-model-call protocol; no new model retry or extra inference probe is introduced.

The tooling is an attributed AGPL adaptation of the reviewed Cloud resolver. Immutable source and Worker provenance successors preserve all previous records, exact dependency versions, full legal text and the complete source-map oracle.
