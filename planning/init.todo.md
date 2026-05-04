# Agent Trading Guardrails Framework - Todo

Date: 2026-05-04
Source plan: `planning/init.planning.md`

## Goal

Build a TypeScript-based guardrails framework that lets OpenClaw and Hermes Agent propose trading actions for Binance spot, Binance USD-M futures, Ethereum Sepolia, and Solana devnet while keeping execution, policy, secrets, signing, network access, and auditability outside the agent runtime.

## Confirmed Decisions

- [x] Create initial architecture plan in `planning/init.planning.md`.
- [x] Choose Sidecar Guardrail Service + Policy-as-Code + Execution Broker as the recommended architecture.
- [x] Choose TypeScript for the first implementation.
- [x] Support OpenClaw and Hermes Agent from the initial integration phase.
- [x] Use Binance as the first CEX connector.
- [x] Scope Binance first to spot plus USD-M futures; exclude margin lending, cross-margin, and COIN-M futures from first scope.
- [x] Use Ethereum Sepolia and Solana devnet as the first onchain targets.
- [x] Embed OPA/Rego from day one for deterministic final authorization.
- [x] Target limited live trading only behind paper trading, testnet, canary limits, human approval policy, and kill-switch coverage.
- [x] Treat human approval thresholds, risk limits, secret backends, and deployment profiles as configuration.
- [x] Use `pnpm` workspaces with a committed lockfile and Corepack-pinned package manager.
- [x] Use Zod as the TypeScript runtime schema source of truth and generate JSON Schema for external contracts.
- [x] Use OPA as a sidecar/local service, with local OPA binary for tests.
- [x] Use `gpt-5.5` as the first reviewer model/provider.
- [x] Use Vault as the first production-grade secret backend.
- [x] Use SQLite append-only audit storage with hash-chain tamper evidence for MVP.
- [x] Use CLI as the first human approval surface, then add local web UI, Slack, Telegram, Discord, WhatsApp, and Signal adapters.
- [x] Treat human approval as escalation-only, not as the default for every trade.
- [x] Allow low-risk allowlisted actions to auto-execute only after reviewer approval plus deterministic policy and risk checks.
- [x] Model allowlists as policy rules over `principal`, `action`, `resource`, and `condition`.
- [x] Use Vault dev server for local development only, with a roadmap for single-node integrated storage, Kubernetes HA integrated storage, and cloud-hosted Vault/HCP.
- [x] Use separate CLI approval commands for `list`, `show`, `approve`, `deny`, and `watch` as the first CLI approval UX.
- [x] Use Drizzle Kit for SQLite audit database migrations.
- [x] Pin OPA v1.16.1: use `opa_linux_amd64_static` in CI and `openpolicyagent/opa:1.16.1-static` in local Docker, with checksums and image digest recorded during implementation.
- [x] Use USD 10/order and USD 50/day as default spot canary-live limits.
- [x] Use USD 5/order and USD 25/day as default USD-M futures canary-live limits.

## Phase 0 - Spec And Threat Model

- [x] Create `docs/threat-model.md`.
- [x] Document attacker profiles: prompt injector, compromised agent runtime, compromised host, malicious tool, malicious RPC/provider, leaked credential user, unsafe strategy.
- [x] Document protected assets: CEX keys, wallet keys, LLM keys, exchange accounts, signer, broker, audit logs, policy bundles, portfolio data.
- [x] Document fail-closed behavior for missing data, stale data, policy errors, reviewer errors, signer errors, RPC disagreement, and broker errors.
- [x] Define supported actions for MVP:
  - [x] `cex.place_order`
  - [x] `cex.cancel_order`
  - [x] `cex.get_open_orders`
  - [x] `cex.get_portfolio`
  - [x] `onchain.simulate_transaction`
  - [x] `onchain.request_signature`
  - [x] `onchain.get_portfolio`
- [x] Define explicitly denied actions for MVP:
  - [x] CEX withdrawal
  - [x] CEX account transfer
  - [x] Spot margin or cross-margin enablement
  - [x] USD-M futures leverage above configured policy cap
  - [x] COIN-M futures trading
  - [x] Unlimited token approval
  - [x] Unknown contract interaction
  - [x] Bridge transaction without human approval
- [x] Define risk tiers: `low`, `medium`, `high`, `critical`.
- [x] Define human approval classes: `none`, `required`, `break_glass`.
- [x] Define policy decision states: `allow`, `deny`, `needs_human`.
- [x] Define automatic execution envelope for reviewer-approved low-risk allowlisted actions.
- [x] Define `needs_human` escalation criteria.
- [x] Define hard-deny criteria that must not be converted into human approval.
- [x] Define one-time approval versus durable allowlist onboarding semantics.
- [x] Define audit event taxonomy.
- [x] Define idempotency strategy for trading and signing requests.
- [x] Define environment profiles: `dev`, `paper`, `testnet`, `canary_live`, `production`.

## Phase 1 - Repository And Tooling

- [x] Initialize TypeScript monorepo.
- [x] Choose `pnpm` workspaces and committed `pnpm-lock.yaml` lockfile policy.
- [x] Add formatting and linting.
- [x] Add unit test runner.
- [x] Add integration test structure.
- [x] Add security-oriented CI checks.
- [x] Pin `opa_linux_amd64_static` v1.16.1 for CI policy tests and verify checksum.
- [x] Pin `openpolicyagent/opa:1.16.1-static` by image digest for local Docker.
- [x] Add `README.md` with project scope and non-goals.
- [x] Add `docs/architecture.md` from the core plan.
- [x] Add `docs/security-boundaries.md`.
- [x] Add `docs/deployment-profiles.md`.
- [x] Add `docs/live-trading-safety.md`.
- [x] Add `.gitignore` for Node, build outputs, local secrets, logs, and test artifacts.
- [x] Add example environment files without real secrets.
- [x] Add contributor note that real keys and wallet seeds must never be committed.
- [x] Add Drizzle Kit configuration for SQLite migrations.

## Phase 2 - Schemas And Core Types

- [x] Create Zod-based trading intent schema package.
- [x] Generate JSON Schema artifacts from Zod schemas.
- [x] Enforce strict schema mode that rejects unknown execution-intent fields.
- [x] Define common intent envelope:
  - [x] `intentId`
  - [x] `principal`
  - [x] `action`
  - [x] `resource`
  - [x] `environment`
  - [x] `requestedAt`
  - [x] `idempotencyKey`
  - [x] `rationale`
  - [x] `evidence`
- [x] Define CEX order intent schema.
- [x] Define CEX cancel intent schema.
- [x] Define onchain simulation intent schema.
- [x] Define onchain signing intent schema.
- [x] Define reviewer verdict schema.
- [x] Define policy input schema passed to OPA.
- [x] Define policy decision schema returned from OPA.
- [x] Define dynamic risk result schema.
- [x] Define broker execution result schema.
- [x] Define audit log event schema.
- [x] Add schema tests for valid and invalid examples.
- [x] Add canonical fixture examples for Binance spot, Binance USD-M futures, Ethereum Sepolia, and Solana devnet.
- [x] Reject ambiguous free-form execution requests in schema tests.

## Phase 3 - Guardrail Service MVP

- [x] Create guardrail service package.
- [x] Add health endpoint.
- [x] Add intent validation endpoint.
- [x] Add reviewer verdict ingestion interface.
- [x] Add OPA policy evaluation interface.
- [x] Add dynamic risk-check orchestration.
- [x] Add final decision endpoint.
- [x] Add idempotency handling.
- [x] Add structured rejection reasons.
- [x] Add request correlation IDs.
- [x] Add local development configuration loader.
- [x] Add fail-closed behavior when OPA is unavailable.
- [x] Add fail-closed behavior when required risk facts are unavailable.
- [x] Add tests for allow, deny, and needs-human flows.

## Phase 4 - OPA/Rego Policy Layer

- [x] Create policy bundle layout.
- [x] Implement default deny.
- [x] Implement explicit deny precedence.
- [x] Implement required reviewer status checks.
- [x] Implement principal/action/resource matching.
- [x] Implement environment-aware policy.
- [x] Implement policy allowlist schema over `principal`, `action`, `resource`, and `condition`.
- [x] Implement automatic execution policy for reviewer-approved low-risk allowlisted actions.
- [x] Implement configurable human approval threshold policy.
- [x] Implement `needs_human` policy for valid but non-automatic escalation cases.
- [x] Implement hard-deny policy for forbidden actions that must not request human approval.
- [x] Implement Binance allowlist policy.
- [x] Implement Binance notional limit policy.
- [x] Implement Binance daily notional limit policy.
- [x] Implement Binance daily loss limit policy.
- [x] Implement spot margin and cross-margin denied policy.
- [x] Implement USD-M futures leverage cap policy.
- [x] Implement COIN-M futures denied policy.
- [x] Implement withdrawal denied policy.
- [x] Implement Ethereum Sepolia allowlist policy.
- [x] Implement Ethereum contract/function/token/spender allowlist policy.
- [x] Implement Ethereum unlimited approval denial policy.
- [x] Implement Solana devnet program/instruction/token/account allowlist policy.
- [x] Implement Solana authority-change denial or human approval policy.
- [x] Add Rego unit tests for auto-allow, needs-human, and hard-deny paths.
- [x] Add Rego tests that reviewer approval alone is insufficient without a matching allowlist.
- [x] Add Rego tests that hard-deny wins over human approval.
- [x] Add policy fixtures for `dev`, `paper`, `testnet`, and `canary_live`.
- [x] Document how TypeScript normalization and live risk facts feed OPA.
- [x] Document OPA v1.16.1 upgrade process and checksum verification.

## Phase 5 - Dynamic Risk Engine

- [x] Create risk engine package.
- [x] Implement market data freshness check.
- [x] Implement portfolio freshness check.
- [x] Implement per-order notional check.
- [x] Implement daily notional check.
- [x] Implement daily loss check.
- [x] Implement slippage and price band check.
- [x] Implement position delta check.
- [x] Implement order frequency and cooldown check.
- [x] Implement unknown data fail-closed result.
- [x] Implement evidence reference validation.
- [x] Implement reviewer verdict consistency check.
- [x] Add tests for stale data, missing data, exceeded limits, and valid low-risk flow.

## Phase 6 - Broker MVP

- [x] Create execution broker package.
- [x] Implement broker API that only accepts approved guardrail decisions.
- [x] Implement broker-side state revalidation before execution.
- [x] Implement broker-side idempotency.
- [x] Implement broker-side kill switch.
- [x] Implement broker-side audit events.
- [x] Implement paper execution mode.
- [x] Implement canary-live execution mode gate.
- [x] Ensure broker never trusts agent-provided balances, prices, or chain state as authoritative.

## Phase 7 - Binance Connector

- [x] Define Binance connector interface.
- [x] Implement Binance public market data access through broker only.
- [x] Implement Binance account snapshot through broker only.
- [x] Implement Binance spot paper order simulation.
- [x] Implement Binance USD-M futures paper order simulation.
- [x] Implement Binance spot live order placement behind `canary_live` policy.
- [x] Implement Binance USD-M futures live order placement behind `canary_live` policy.
- [x] Implement Binance cancel order.
- [x] Implement Binance order status polling.
- [x] Enforce spot margin and cross-margin exclusion.
- [x] Enforce COIN-M futures exclusion.
- [x] Enforce USD-M futures isolated-mode and leverage-cap policy.
- [x] Enforce no-withdrawal API key requirement in docs and runtime checks where possible.
- [x] Enforce subaccount/account allowlist.
- [x] Enforce IP allowlist requirement in deployment docs.
- [x] Add integration tests with mocked Binance API.
- [x] Add optional sandbox/testnet tests if Binance environment supports required flow.

## Phase 8 - Ethereum Sepolia Onchain Connector

- [x] Define EVM connector interface.
- [x] Implement Ethereum Sepolia RPC provider adapter.
- [x] Implement transaction decoding.
- [x] Implement ERC-20 approval detection.
- [x] Implement unlimited approval rejection.
- [x] Implement contract/function/token/spender allowlist checks.
- [x] Implement transaction simulation.
- [x] Implement expected balance delta comparison.
- [x] Implement signer interface without exposing private keys to agent runtime.
- [x] Implement local dev signer for testnet only.
- [x] Add tests for unknown contract, known contract, approval, unlimited approval, and failed simulation.

## Phase 9 - Solana Devnet Onchain Connector

- [x] Define Solana connector interface.
- [x] Implement Solana devnet RPC provider adapter.
- [x] Implement instruction parsing.
- [x] Implement program allowlist checks.
- [x] Implement token/account/authority checks.
- [x] Implement simulation before signing.
- [x] Implement expected balance delta comparison.
- [x] Implement signer interface without exposing private keys to agent runtime.
- [x] Implement local dev signer for devnet only.
- [x] Add tests for unknown program, known program, authority change, token transfer, and failed simulation.

## Phase 10 - Secret And Signing Boundary

- [x] Define secret provider interface.
- [x] Implement local development secret provider.
- [x] Choose Vault as the first production-grade secret backend.
- [x] Implement Vault dev server profile for local development only.
- [x] Implement Vault secret provider adapter.
- [x] Document Vault single-node integrated storage profile for single VPS.
- [x] Document Vault Kubernetes HA integrated storage profile.
- [x] Document cloud-hosted Vault/HCP profile.
- [x] Add guardrail that production profiles cannot use Vault dev server.
- [x] Define signer backend interface.
- [x] Implement local testnet signer backend.
- [x] Document KMS adapter requirements.
- [x] Document HSM adapter requirements.
- [x] Document MPC adapter requirements.
- [x] Add secret redaction utility for logs and errors.
- [x] Add tests that secrets are not returned through agent-facing APIs.
- [x] Add key rotation and emergency revocation runbook.

## Phase 11 - Reviewer Agent Layer

- [x] Define reviewer prompt contract.
- [x] Define reviewer input schema.
- [x] Define reviewer output schema.
- [x] Implement reviewer adapter interface.
- [x] Implement `gpt-5.5` reviewer provider adapter.
- [x] Ensure reviewer verdict is advisory, not final authorization.
- [x] Add prompt injection detection labels.
- [x] Add unsupported-claim detection labels.
- [x] Add mismatch-between-evidence-and-action labels.
- [x] Add tests for reviewer output parsing.
- [x] Add fail-closed behavior for malformed reviewer output.

## Phase 12 - Agent Integrations

- [x] Define common guarded tool surface.
- [x] Implement OpenClaw adapter.
- [x] Implement Hermes Agent adapter.
- [x] Expose only guarded proposal/query tools.
- [x] Prevent direct CEX tool exposure.
- [x] Prevent direct RPC/signing tool exposure.
- [x] Return structured reject reasons to agents.
- [x] Add example OpenClaw strategy using guarded tools.
- [x] Add example Hermes Agent strategy using guarded tools.
- [x] Add end-to-end tests that both agents can propose valid intents.
- [x] Add end-to-end tests that both agents cannot access keys or direct execution paths.

## Phase 13 - Runtime Isolation And Network Controls

- [x] Create local Docker deployment profile.
- [x] Run agent container as non-root.
- [x] Drop unnecessary Linux capabilities.
- [x] Add read-only mounts where feasible.
- [x] Ensure Docker socket is not mounted into agent containers.
- [x] Block host home directory, SSH keys, cloud credentials, browser profiles, and wallet files from agent mounts.
- [x] Add egress proxy for agent runtime.
- [x] Allowlist LLM providers.
- [x] Allowlist guardrail service.
- [x] Allowlist explicitly approved data sources.
- [x] Block CEX APIs from agent containers.
- [x] Block RPC endpoints from agent containers.
- [x] Block metadata service endpoints.
- [x] Block RFC1918/internal ranges by default.
- [x] Log DNS and egress attempts.
- [x] Document single VPS deployment profile.
- [x] Document Kubernetes deployment profile.
- [x] Document cloud-managed runtime deployment profile.
- [x] Add tests or scripts that verify blocked egress paths.

## Phase 14 - Audit Log And Monitoring

- [x] Implement append-only audit event writer.
- [x] Include agent identity in audit events.
- [x] Include prompt/session ID in audit events.
- [x] Include input data references in audit events.
- [x] Include normalized intent JSON in audit events.
- [x] Include reviewer verdict in audit events.
- [x] Include OPA input and output in audit events.
- [x] Include dynamic risk check results in audit events.
- [x] Include broker revalidation results in audit events.
- [x] Include CEX order ID or transaction hash in audit events.
- [x] Include human approval details in audit events.
- [x] Add Drizzle Kit migration for initial audit tables.
- [x] Add migration test that applies SQLite schema from an empty database.
- [x] Add hash-chain or tamper-evidence design.
- [x] Add tests for audit completeness on allow, deny, needs-human, and error flows.

## Phase 15 - Human Approval And Kill Switch

- [x] Define human approval API.
- [x] Define approval state machine.
- [x] Implement approval timeout behavior.
- [x] Implement approval audit logging.
- [x] Implement configurable approval thresholds.
- [x] Implement approval decision type: one-time execution approval.
- [x] Implement approval decision type: durable allowlist onboarding request.
- [x] Ensure durable allowlist onboarding creates an auditable policy change, not hidden runtime state.
- [x] Implement `guardrail approvals list`.
- [x] Implement `guardrail approvals show <approvalId>`.
- [x] Implement `guardrail approvals approve <approvalId>`.
- [x] Implement `guardrail approvals deny <approvalId>`.
- [x] Implement `guardrail approvals watch`.
- [x] Ensure agent execution creates pending approvals without requiring an attached interactive terminal.
- [x] Design local web UI approval adapter.
- [x] Design Slack approval adapter.
- [x] Design Telegram approval adapter.
- [x] Design Discord approval adapter.
- [x] Design WhatsApp approval adapter.
- [x] Design Signal approval adapter.
- [x] Implement global kill switch.
- [x] Implement per-agent kill switch.
- [x] Implement per-account kill switch.
- [x] Implement per-exchange kill switch.
- [x] Implement per-chain kill switch.
- [x] Add tests that live execution cannot bypass required approval.
- [x] Add tests that kill switch blocks broker execution.

## Phase 16 - Limited Live Trading Gates

- [x] Define `canary_live` policy bundle.
- [x] Set default Binance spot canary-live notional to USD 10/order and USD 50/day.
- [x] Set default Binance USD-M futures canary-live notional to USD 5/order and USD 25/day.
- [x] Enforce default USD-M futures max leverage of 1x in canary-live.
- [x] Require explicit configuration to enable live mode.
- [x] Require Binance no-withdrawal key before live mode.
- [x] Require Binance IP allowlist before live mode.
- [x] Require audit log enabled before live mode.
- [x] Require kill switch enabled before live mode.
- [x] Require human approval for live mode until policy explicitly allows no-human low-risk trades.
- [x] Add dry-run report before first live trade.
- [x] Add post-trade reconciliation after first live trade.
- [x] Add rollback procedure for live mode.

## Phase 17 - Red Team And Hardening

- [x] Build prompt injection fixture suite.
- [x] Test malicious webpage instructions.
- [x] Test malicious repository instructions.
- [x] Test malicious token metadata.
- [x] Test malicious MCP/tool definitions.
- [x] Test attempted secret exfiltration through prompts.
- [x] Test attempted secret exfiltration through logs.
- [x] Test attempted arbitrary egress.
- [x] Test attempted direct CEX access from agent runtime.
- [x] Test attempted direct RPC access from agent runtime.
- [x] Test hallucinated price/balance/position claims.
- [x] Test invalid reviewer output.
- [x] Test reviewer `approve` plus matching allowlist auto-executes within low-risk limits.
- [x] Test reviewer `approve` without matching allowlist does not auto-execute.
- [x] Test threshold breach returns `needs_human` when below hard-deny threshold.
- [x] Test hard-deny actions never become human approval requests.
- [x] Test malformed policy input.
- [x] Test OPA unavailable.
- [x] Test broker unavailable.
- [x] Test signer unavailable.
- [x] Test stale market data.
- [x] Test stale portfolio data.
- [x] Test unauthorized withdrawal.
- [x] Test unauthorized transfer.
- [x] Test unknown onchain contract.
- [x] Test unlimited approval.
- [x] Test Solana authority change.
- [x] Test repeated rejection cooldown.
- [x] Document findings and fixes.

## Phase 18 - RPC Eclipse And BGP Split Future Work

- [ ] Define RPC quorum service interface.
- [ ] Add provider metadata: provider, region, ASN if available, chain, environment.
- [ ] Compare chain ID across providers.
- [ ] Compare latest block number across providers.
- [ ] Compare block hash across providers.
- [ ] Compare finalized checkpoint where supported.
- [ ] Compare gas data across providers.
- [ ] Compare account state across providers for high-risk actions.
- [ ] Require quorum before high-risk signing.
- [ ] Fail closed on provider disagreement beyond tolerance.
- [ ] Confirm transaction inclusion from multiple independent sources.
- [ ] Document self-hosted node requirements.

## Cross-Cutting Validation

- [x] Run formatting checks.
- [x] Run lint checks.
- [x] Run TypeScript type checks.
- [x] Run unit tests.
- [x] Run integration tests with mocked CEX/RPC providers.
- [x] Run Rego policy tests.
- [x] Run end-to-end paper trading flow.
- [x] Run Ethereum Sepolia simulation/signing flow.
- [x] Run Solana devnet simulation/signing flow.
- [x] Run agent integration tests for OpenClaw and Hermes.
- [x] Run sandbox egress-block tests.
- [x] Run secret redaction tests.
- [x] Run audit completeness tests.

## Dependencies

- [x] Choose package manager: `pnpm` workspaces with committed lockfile.
- [x] Choose schema validation: Zod source of truth plus generated JSON Schema.
- [x] Choose OPA integration mode: sidecar/local service, with local OPA binary for tests.
- [x] Choose OPA distribution: `opa_linux_amd64_static` v1.16.1 for CI and `openpolicyagent/opa:1.16.1-static` pinned by digest for Docker.
- [x] Choose first reviewer model/provider: `gpt-5.5`.
- [x] Choose first production secret backend: Vault.
- [x] Choose first Vault deployment mode: dev server for local development only.
- [x] Choose Vault deployment roadmap: single-node integrated storage, Kubernetes HA integrated storage, cloud-hosted Vault/HCP.
- [x] Choose Binance connector approach: thin broker-owned signed REST client for limited spot and USD-M futures endpoints.
- [x] Choose EVM library: `viem`.
- [x] Choose Solana library: `@solana/web3.js`.
- [x] Choose audit log storage backend: SQLite append-only audit table with hash-chain tamper evidence and JSONL export.
- [x] Choose SQLite migration tool: Drizzle Kit.
- [x] Choose container/network enforcement approach for local Docker: Docker Compose profile, dedicated agent network, egress proxy, and DOCKER-USER/nftables firewall rules.

## Resolved Follow-Up Decisions

- [x] First Ethereum testnet: Sepolia.
- [x] First Solana environment: devnet.
- [x] First human approval surface: CLI.
- [x] Later human approval adapters: local web UI, Slack, Telegram, Discord, WhatsApp, and Signal.
- [x] First CLI approval UX: separate approval commands for `list`, `show`, `approve`, `deny`, and `watch`.
- [x] Binance first account modes: spot and USD-M futures.
- [x] Binance excluded first account modes: margin lending, cross-margin, and COIN-M futures.

## Open Questions

None for the current planning stage.
