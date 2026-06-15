# Project Handoff: Unfinished and Incomplete Areas

## High Priority

### 1. Guardrail HTTP service layer is missing

Evidence:

- `packages/guardrail-service/src/index.ts` only exports library symbols.
- `packages/guardrail-service/src/service.ts` exposes an in-process `GuardrailService` class.
- `planning/review_1.todo.md` still lists unchecked work for `packages/guardrail-service/src/server.ts`, `GET /health`, `POST /evaluate`, request validation, correlation ID injection, and endpoint tests.
- The only observed `createServer` / `listen` usage in `packages/guardrail-service/src` is test scaffolding for the OPA evaluator integration test.

Impact:

The internal guardrail logic is reasonably complete, but the project does not yet provide a deployable guardrail API service.

### 2. Runtime and deployment artifacts are still incomplete

Evidence:

- `docs/deployment-profiles.md` states that local Docker currently starts only supporting services and that standalone agent, guardrail-service, broker, and egress-proxy runtime containers are not implemented yet.
- `deploy/docker/Dockerfile.agent` exits with `No standalone agent runtime entrypoint is defined yet.`
- `deploy/docker/Dockerfile.broker` exits with `No standalone broker runtime entrypoint is defined yet.`
- The `deploy/` directory only contains those two Dockerfiles.

Impact:

The codebase can build and test, but it is not currently a complete one-command deployable production system.

### 3. Production execution is explicitly unsupported

Evidence:

- `packages/broker/src/broker.ts` rejects `environment === "production"` with `production_not_supported`.
- `docs/live-trading-safety.md` describes production as a reserved/planned profile.

Impact:

The current execution scope is development, paper, testnet, and canary-live style operation. Full production trading is not enabled.

### 4. Live trading preflight is not complete

Evidence:

`planning/review_1.todo.md` still has unchecked items for:

- `packages/broker/src/preflight.ts`.
- Audit log health checks.
- Kill switch reachability checks.
- Approval store accessibility checks.
- Binance no-withdrawal key validation.
- Binance IP allowlist configuration.
- Dry-run reporting before the first live trade.
- Post-trade reconciliation after the first live trade.

Impact:

Canary-live rules exist, but the full operator preflight/report/reconciliation flow before real-money execution is not complete.

### 5. Human approval integrations are mostly placeholders

Evidence:

- `packages/approval/src/adapters.ts` implements only `ConsoleNotifier`.
- Slack, Telegram, Discord, WhatsApp, Signal, and Web UI support are represented as config interfaces and future-implementation notes, not working adapters.
- `ApprovalStore` stores pending approvals in `private requests = new Map`, so approval state is not durable by default.

Impact:

The approval model and CLI/in-memory flow exist, but production-grade notification, persistence, and operator authentication/authorization remain incomplete.

### 6. Egress and network isolation are mostly deployment requirements, not fully implemented artifacts

Evidence:

- `docs/security-boundaries.md` states that network and filesystem restrictions are deployment-time controls.
- `docs/deployment-profiles.md` states that local Docker does not provide the complete sandbox boundary.
- `planning/review_1.todo.md` still lists unchecked work for DNS logging, persistent egress logs, and nginx-egress/docker-compose updates.
- The current `deploy/` directory does not contain complete egress proxy, firewall, Docker Compose, or Kubernetes NetworkPolicy artifacts.

Impact:

The security model correctly says agents must not directly reach exchanges, RPC endpoints, internal networks, or metadata services, but the repository does not yet automatically enforce all of those boundaries.

### 7. Production-grade KMS/HSM/MPC signer backends are not implemented

Evidence:

- `docs/signing-backends.md` defines requirements for KMS, HSM, and MPC adapters, including implementing `SignerBackend`, keeping key material inside the signing boundary, supporting rotation, and producing signing audit trails.
- `docs/deployment-profiles.md` says wallet private keys should stay in KMS/HSM/MPC backends and Vault should store only references or signer configuration.
- The inspected source contains local/dev signer implementations and connector signer interfaces, but no concrete KMS, HSM, or MPC signer backend implementation.

Impact:

The repository has the right signing-boundary design, but production wallet signing infrastructure is still missing. Real live deployments need a concrete KMS/HSM/MPC adapter before wallet private keys can be handled with production-grade controls.

## Medium Priority

### 8. Integration test gate is loose

Evidence:

- `vitest.config.ts` and `vitest.integration.config.ts` both set `passWithNoTests: true`.
- `package.json` defines `ci` as `pnpm lint && pnpm typecheck && pnpm test`, so `pnpm test:integration` is not part of the default CI script.
- There are integration tests for guardrail-service OPA paths, EVM Sepolia provider, and Solana devnet provider, but the planned Binance HTTP-level integration tests and agent-adapter service-stack integration tests remain incomplete.

Impact:

The test suite is substantial, but integration coverage is not part of the default CI command and some planned integration paths are still missing.

### 9. Binance has no built-in real REST client implementation

Evidence:

- `packages/binance-connector/src/interfaces.ts` defines `BinanceApiClient`.
- `packages/binance-connector/src/connector.ts` receives that client by dependency injection.
- No concrete signed Binance REST client implementation was found in the connector source.

Impact:

The Binance connector has validation and execution orchestration logic, but real Binance API access must be provided externally or implemented later.

### 10. EVM and Solana provider balance-delta support is still skeletal

Evidence:

- `packages/evm-connector/src/sepolia-provider.ts` returns `balanceChangesReliable: false`.
- `packages/solana-connector/src/devnet-provider.ts` also returns `balanceChangesReliable: false`.
- The connectors require reliable expected-delta checks for `onchain.request_signature`.

Impact:

The simulation/signing flow exists, but reliable balance-change extraction for real signing flows is not fully implemented in the built-in providers.

### 11. Risk Engine coverage for onchain actions is thin

Evidence:

- Several checks in `packages/risk-engine/src/checks.ts` return pass for non-`cex.place_order` intents.
- Onchain safety is handled more by connector simulation, policy allowlists, and expected-delta checks than by the dynamic risk engine itself.

Impact:

Onchain protection exists, but it is not uniformly covered by the same dynamic risk engine checks used for CEX order flow.

### 12. Prompt-injection detection is pattern-based

Evidence:

- `packages/guardrail-service/src/service.ts` uses hard-coded regular expressions for unsafe-content detection.
- `docs/red-team-findings.md` explicitly warns that this detector should not be treated as comprehensive natural-language security analysis.

Impact:

The detector covers known fixtures and common patterns, but it is not a complete NLP security layer.

## Overall Maturity Assessment

- The security architecture is strong and internally consistent.
- Core TypeScript schemas, OPA policy, broker checks, connector safety checks, and tests are in good shape.
- The project is suitable as a security-focused framework prototype or internal MVP.
- It is not yet a complete production trading platform.

The short version: this repository has a serious safety kernel for preventing AI agents from directly moving money, but it still needs the deployable service/runtime layer, real operational integrations, live-trading preflight, durable approval infrastructure, concrete KMS/HSM/MPC signer backends, and production-grade execution backends before it can be considered production-ready.
