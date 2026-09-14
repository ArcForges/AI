# Security policy

The latest `main` commit is the supported development line. This Hello Agent is a private bootstrap, not a production service for untrusted users or sensitive inputs.

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/ArcForges/AI/security/advisories/new). Include the affected commit/version, reproduction steps, impact and sanitized logs. Do not open a public issue containing exploit details or credentials. Maintainers will investigate and coordinate disclosure; no fixed response-time SLA is promised for this new project.

Cloudflare credentials belong in the repository's protected `cloudflare` environment or the local Wrangler credential store. Never commit them, put them in a prompt, upload them as an artifact or use the Cloudflare Global API Key. Rotate a leaked token in Cloudflare and replace the GitHub secret.

The demo accepts only a small name, validates the proposed tool and performs one deterministic protobuf greeting. It has no filesystem, external tool executor or public inference endpoint. Workflow checkpoints and observability can retain demo input/output, so use non-sensitive test names only. Account users with sufficient Cloudflare permissions can invoke runs and incur model usage.

CI includes lockfile checks, dependency review, a high-severity dependency audit, secret scanning and CodeQL for TypeScript/JavaScript and GitHub Actions. Passing these checks is not a production security assessment or evidence of real model behavior.
