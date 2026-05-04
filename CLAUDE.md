# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install dependencies: `corepack enable && pnpm install`
- Create local env file: `cp env.example .env`
- Build all TypeScript project references: `pnpm build`
- Typecheck all project references: `pnpm typecheck`
- Run lint: `pnpm lint`
- Apply lint fixes: `pnpm lint:fix`
- Format files: `pnpm format`
- Check formatting: `pnpm format:check`
- Run unit tests: `pnpm test`
- Run tests in watch mode: `pnpm test:watch`
- Run coverage: `pnpm test:coverage`
- Run quick local CI script: `pnpm ci`
- Run one test file: `pnpm vitest run packages/guardrail-service/src/service.test.ts`
- Run tests matching a name: `pnpm vitest run -t "schema validation"`
- Run integration tests: `pnpm test:integration`
- Run Rego policy tests with a local OPA binary: `opa test packages/policy/src -v`
- Build one workspace package: `pnpm --filter @guardrails/schemas build`
- Generate JSON schemas: `pnpm --filter @guardrails/schemas generate:json-schema`
- Start the local Docker stack: `docker compose --profile dev up --build`

GitHub CI uses Node 22, pnpm, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:integration`, OPA v1.16.1 policy tests, and `pnpm audit --audit-level=high`.

## Architecture

This is a pnpm TypeScript monorepo (`packages/*`) for a security boundary between AI trading agents and financial execution. Packages are ESM TypeScript packages with Node16 module resolution and composite project references from the root `tsconfig.json`.

The core flow is:

```text
Agent adapter
  -> strict trading intent schemas
  -> GuardrailService validation/idempotency/reviewer/risk/policy decision
  -> human approval when required
  -> ExecutionBroker revalidation/kill switch/idempotency/audit
  -> exchange or onchain connector
```

Key packages:

- `@guardrails/schemas`: shared Zod schemas, common enums, fixtures, and generated JSON schema support. Add or change intent shapes here before updating downstream service, policy, risk, broker, connector, and red-team coverage.
- `@guardrails/agent-adapters`: guarded tool surface for OpenClaw and Hermes Agent. It should only construct structured intents and submit them to the guardrail service.
- `@guardrails/service`: orchestrates intent parsing, idempotency, OPA health checks, reviewer verdict parsing, dynamic risk evaluation, policy input normalization, and final `allow` / `deny` / `needs_human` decisions.
- `@guardrails/reviewer`: advisory LLM reviewer prompt/parser/adapter. Reviewer output must be structured JSON and cannot execute, sign, approve secrets, or bypass policy.
- `packages/policy`: OPA/Rego deterministic authorization layer. `main.rego` combines hard-deny, escalation, and allowlist rules; limits and allowlists live in `policy.json`.
- `@guardrails/risk-engine`: live checks that are awkward in Rego, including market and portfolio freshness, per-order and daily notional, daily loss, slippage, position delta, order frequency, evidence references, and reviewer consistency.
- `@guardrails/broker`: execution boundary. It only executes approved decisions, rechecks kill switches, gates canary/production modes, calls connector `revalidate` before `execute`, records audit events, and stores broker idempotency results.
- `@guardrails/binance-connector`, `@guardrails/evm-connector`, `@guardrails/solana-connector`: connector implementations around broker interfaces; keep exchange/RPC/signing access on this side of the boundary.
- `@guardrails/audit`: SQLite/Drizzle audit writer with hash-chain tamper evidence. Root `drizzle.config.ts` points at `packages/audit/src/schema.ts`.
- `@guardrails/secrets`: local/Vault secret providers, local signer, env guards, and redaction helpers.
- `@guardrails/approval`: human approval request lifecycle, CLI, notifiers, and store abstractions.
- `@guardrails/red-team`: cross-cutting regression tests for prompt injection, malformed reviewer output, policy bypass, live trading gates, and related security cases.

## Project-specific invariants

- Treat the agent runtime as untrusted. Agents submit structured intents through guarded adapters; they must not receive exchange keys, wallet keys, direct exchange/RPC access, Docker socket access, or host credentials.
- The reviewer is advisory. Deterministic policy, dynamic risk checks, and broker-side revalidation are the authoritative enforcement layers.
- The system should fail closed when schema validation, reviewer parsing, policy evaluation, OPA health, or required risk facts are unavailable.
- OPA hard-deny rules take precedence over human escalation and allow rules. CEX withdrawals, account transfers, margin/cross-margin, COIN-M futures, leverage above caps, unlimited token approvals, and unknown onchain contracts/programs are denied by policy.
- Live trading progresses `dev -> paper -> testnet -> canary_live -> production`. Broker execution currently rejects `production`; `canary_live` requires explicit enablement and tight limits.
- Supported first-scope integrations are OpenClaw/Hermes agents, Binance spot and USD-M futures, Ethereum Sepolia, and Solana devnet.
- Keep execution capability out of `agent-adapters`, `reviewer`, and `guardrail-service`; only broker connectors should execute or sign after an allowed decision.

## Code conventions

- Use `pnpm` with Node >= 22. The pinned package manager is `pnpm@10.33.2`.
- Keep `.js` extensions in relative TypeScript imports because packages compile as Node16 ESM.
- Biome owns formatting and linting: 2-space indent, double quotes, semicolons, trailing commas, 100-character line width, no unused imports/variables.
- Unit tests live under `packages/*/src/**/*.test.ts`; integration tests are selected by `packages/*/src/**/*.integration.test.ts`.
- Use `env.example` as the environment template file name.

## Lessons

- Use root `pnpm build` or `pnpm typecheck` for monorepo-wide TypeScript validation; both run `tsc -b` across project references.
- Reviewer fixtures and env defaults use `REVIEWER_PROVIDER=openai` and `REVIEWER_MODEL=gpt-5.5`.
- OPA is pinned to v1.16.1 in CI and Docker; policy upgrades require checksum and image digest updates plus `opa test packages/policy/src -v`.
