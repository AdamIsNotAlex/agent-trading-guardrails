# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript pnpm workspace for agent trading guardrails. Source code lives in
`packages/*/src`, with each package owning a focused boundary such as `guardrail-service`,
`broker`, `risk-engine`, `reviewer`, `secrets`, `audit`, and chain or exchange connectors.
Tests are colocated beside source as `*.test.ts`. JSON schemas are in
`packages/schemas/json-schema`, Rego policy rules and policy tests are in `packages/policy/src`,
deployment assets are in `deploy/`, and design/security documentation is in `docs/`.

## Build, Test, and Development Commands

- `corepack enable`: enable the pnpm version declared by the repo.
- `pnpm install`: install workspace dependencies.
- `pnpm build`: run `tsc -b` across the monorepo.
- `pnpm typecheck`: typecheck all TypeScript projects.
- `pnpm test`: run unit tests with Vitest.
- `pnpm test:watch`: run Vitest in watch mode during development.
- `pnpm test:coverage`: run Vitest with V8 coverage.
- `pnpm test:integration`: run `*.integration.test.ts` using the integration config.
- `pnpm lint`: run Biome checks.
- `pnpm lint:fix` or `pnpm format`: apply safe Biome fixes/formatting.
- `pnpm run ci`: run lint, typecheck, unit tests, and integration tests before opening a PR.

## Coding Style & Naming Conventions

Use TypeScript with ESM-style imports/exports. Biome enforces 2-space indentation, double quotes,
semicolons, trailing commas, and a 100-character line width. Keep module names kebab-case
(`paper-connector.ts`) and exported types/classes descriptive (`PolicyInput`, `AuditWriter`).
Prefer explicit interfaces at package boundaries and avoid non-null assertions unless justified.

## Testing Guidelines

The unit configuration discovers `packages/*/src/**/*.test.ts` but excludes `*.integration.test.ts`;
the integration configuration discovers `packages/*/src/**/*.integration.test.ts` only.
Both configurations fail when no test files are discovered.

Place tests next to the code they exercise and name them
after the behavior or module, for example `broker.test.ts` or `connector.test.ts`. Add coverage when
changing policy decisions, signing/secrets behavior, execution paths, audit integrity, or risk
checks. Run `pnpm run ci` for broad validation.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Add Phase 15 human approval system` and
`Fix CI test failures by using tsc -b for monorepo builds`. Keep subjects concise and describe the
observable change. PRs should include a brief summary, test results, linked issues or planning docs
when relevant, and screenshots or logs only for user-visible CLI/deployment behavior.

## Security & Configuration Tips

Never commit real API keys, wallet private keys, seed phrases, or production `.env` files. Start from
`env.example`, keep secrets outside the agent runtime, and preserve the architecture rule that
reviewer output is advisory while policy and broker boundaries remain authoritative.

## Lessons

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`; urgent security patch overrides for
  newly released packages must also add matching `minimumReleaseAgeExclude` entries, including
  package-specific binary packages such as `@esbuild/*` when overriding `esbuild`.
- `vitest.config.ts` excludes `**/*.integration.test.ts` while preserving `configDefaults.exclude`.
  Both configs fail on empty discovery; `pnpm run ci` runs unit and integration suites separately.
  On a clean checkout, run `pnpm build` before either suite because workspace package exports
  target `dist/`; the GitHub Actions workflow already preserves that order.
- The real-Rego transform integration is conditional on `opa` being on `PATH`; without it, the
  suite is skipped even with `passWithNoTests: false`. The separate GitHub Actions
  `opa-policy-test` job does not install OPA in the integration-test job.
- Standalone Guardrail and broker audit chains need separate SQLite databases and hash anchors:
  `AuditWriter` retains its chain head in memory, so sharing a chain across processes is unsafe.
- HTTP response `x-correlation-id` identifies the current request. A cached `needs_human`
  decision retains its original body correlation ID and token to preserve the approval binding;
  clients must not rewrite the signed decision to match the transport header.
- `transformOpaOutput` validates more than the `PolicyOutput` schema: every allow reason's
  `rule` must appear in `matchedAllowRules`. HTTP fixtures must preserve that relationship
  or the real service correctly converts them into fail-closed denials.
- `pnpm run ci` does not run dependency audits. Verify both `pnpm audit --audit-level=high --prod`
  and `pnpm audit --audit-level=high` after dependency fixes: development-only paths can fail
  `CI / security` even when the production audit passes.
