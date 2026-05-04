# Agent Trading Guardrails Framework - Todo

Date: 2026-05-04
Source plan: `planning/init.planning.md`

## Goal

Build a TypeScript-based guardrails framework that lets OpenClaw and Hermes Agent propose trading actions for Binance, Ethereum, and Solana while keeping execution, policy, secrets, signing, network access, and auditability outside the agent runtime.

## Confirmed Decisions

- [x] Create initial architecture plan in `planning/init.planning.md`.
- [x] Choose Sidecar Guardrail Service + Policy-as-Code + Execution Broker as the recommended architecture.
- [x] Choose TypeScript for the first implementation.
- [x] Support OpenClaw and Hermes Agent from the initial integration phase.
- [x] Use Binance as the first CEX connector.
- [x] Use Ethereum and Solana as the first onchain targets.
- [x] Embed OPA/Rego from day one for deterministic final authorization.
- [x] Target limited live trading only behind paper trading, testnet, canary limits, human approval policy, and kill-switch coverage.
- [x] Treat human approval thresholds, risk limits, secret backends, and deployment profiles as configuration.

## Phase 0 - Spec And Threat Model

- [ ] Create `docs/threat-model.md`.
- [ ] Document attacker profiles: prompt injector, compromised agent runtime, compromised host, malicious tool, malicious RPC/provider, leaked credential user, unsafe strategy.
- [ ] Document protected assets: CEX keys, wallet keys, LLM keys, exchange accounts, signer, broker, audit logs, policy bundles, portfolio data.
- [ ] Document fail-closed behavior for missing data, stale data, policy errors, reviewer errors, signer errors, RPC disagreement, and broker errors.
- [ ] Define supported actions for MVP:
  - [ ] `cex.place_order`
  - [ ] `cex.cancel_order`
  - [ ] `cex.get_open_orders`
  - [ ] `cex.get_portfolio`
  - [ ] `onchain.simulate_transaction`
  - [ ] `onchain.request_signature`
  - [ ] `onchain.get_portfolio`
- [ ] Define explicitly denied actions for MVP:
  - [ ] CEX withdrawal
  - [ ] CEX account transfer
  - [ ] Leverage or margin enablement
  - [ ] Unlimited token approval
  - [ ] Unknown contract interaction
  - [ ] Bridge transaction without human approval
- [ ] Define risk tiers: `low`, `medium`, `high`, `critical`.
- [ ] Define human approval classes: `none`, `required`, `break_glass`.
- [ ] Define policy decision states: `allow`, `deny`, `needs_human`.
- [ ] Define audit event taxonomy.
- [ ] Define idempotency strategy for trading and signing requests.
- [ ] Define environment profiles: `dev`, `paper`, `testnet`, `canary_live`, `production`.

## Phase 1 - Repository And Tooling

- [ ] Initialize TypeScript monorepo.
- [ ] Choose package manager and lockfile policy.
- [ ] Add formatting and linting.
- [ ] Add unit test runner.
- [ ] Add integration test structure.
- [ ] Add security-oriented CI checks.
- [ ] Add `README.md` with project scope and non-goals.
- [ ] Add `docs/architecture.md` from the core plan.
- [ ] Add `docs/security-boundaries.md`.
- [ ] Add `docs/deployment-profiles.md`.
- [ ] Add `docs/live-trading-safety.md`.
- [ ] Add `.gitignore` for Node, build outputs, local secrets, logs, and test artifacts.
- [ ] Add example environment files without real secrets.
- [ ] Add contributor note that real keys and wallet seeds must never be committed.

## Phase 2 - Schemas And Core Types

- [ ] Create trading intent schema package.
- [ ] Define common intent envelope:
  - [ ] `intentId`
  - [ ] `principal`
  - [ ] `action`
  - [ ] `resource`
  - [ ] `environment`
  - [ ] `requestedAt`
  - [ ] `idempotencyKey`
  - [ ] `rationale`
  - [ ] `evidence`
- [ ] Define CEX order intent schema.
- [ ] Define CEX cancel intent schema.
- [ ] Define onchain simulation intent schema.
- [ ] Define onchain signing intent schema.
- [ ] Define reviewer verdict schema.
- [ ] Define policy input schema passed to OPA.
- [ ] Define policy decision schema returned from OPA.
- [ ] Define dynamic risk result schema.
- [ ] Define broker execution result schema.
- [ ] Define audit log event schema.
- [ ] Add schema tests for valid and invalid examples.
- [ ] Add canonical fixture examples for Binance, Ethereum, and Solana.
- [ ] Reject ambiguous free-form execution requests in schema tests.

## Phase 3 - Guardrail Service MVP

- [ ] Create guardrail service package.
- [ ] Add health endpoint.
- [ ] Add intent validation endpoint.
- [ ] Add reviewer verdict ingestion interface.
- [ ] Add OPA policy evaluation interface.
- [ ] Add dynamic risk-check orchestration.
- [ ] Add final decision endpoint.
- [ ] Add idempotency handling.
- [ ] Add structured rejection reasons.
- [ ] Add request correlation IDs.
- [ ] Add local development configuration loader.
- [ ] Add fail-closed behavior when OPA is unavailable.
- [ ] Add fail-closed behavior when required risk facts are unavailable.
- [ ] Add tests for allow, deny, and needs-human flows.

## Phase 4 - OPA/Rego Policy Layer

- [ ] Create policy bundle layout.
- [ ] Implement default deny.
- [ ] Implement explicit deny precedence.
- [ ] Implement required reviewer status checks.
- [ ] Implement principal/action/resource matching.
- [ ] Implement environment-aware policy.
- [ ] Implement configurable human approval threshold policy.
- [ ] Implement Binance allowlist policy.
- [ ] Implement Binance notional limit policy.
- [ ] Implement Binance daily notional limit policy.
- [ ] Implement Binance daily loss limit policy.
- [ ] Implement leverage denied policy.
- [ ] Implement withdrawal denied policy.
- [ ] Implement Ethereum chain allowlist policy.
- [ ] Implement Ethereum contract/function/token/spender allowlist policy.
- [ ] Implement Ethereum unlimited approval denial policy.
- [ ] Implement Solana program/instruction/token/account allowlist policy.
- [ ] Implement Solana authority-change denial or human approval policy.
- [ ] Add Rego unit tests for each allow/deny path.
- [ ] Add policy fixtures for `dev`, `paper`, `testnet`, and `canary_live`.
- [ ] Document how TypeScript normalization and live risk facts feed OPA.

## Phase 5 - Dynamic Risk Engine

- [ ] Create risk engine package.
- [ ] Implement market data freshness check.
- [ ] Implement portfolio freshness check.
- [ ] Implement per-order notional check.
- [ ] Implement daily notional check.
- [ ] Implement daily loss check.
- [ ] Implement slippage and price band check.
- [ ] Implement position delta check.
- [ ] Implement order frequency and cooldown check.
- [ ] Implement unknown data fail-closed result.
- [ ] Implement evidence reference validation.
- [ ] Implement reviewer verdict consistency check.
- [ ] Add tests for stale data, missing data, exceeded limits, and valid low-risk flow.

## Phase 6 - Broker MVP

- [ ] Create execution broker package.
- [ ] Implement broker API that only accepts approved guardrail decisions.
- [ ] Implement broker-side state revalidation before execution.
- [ ] Implement broker-side idempotency.
- [ ] Implement broker-side kill switch.
- [ ] Implement broker-side audit events.
- [ ] Implement paper execution mode.
- [ ] Implement canary-live execution mode gate.
- [ ] Ensure broker never trusts agent-provided balances, prices, or chain state as authoritative.

## Phase 7 - Binance Connector

- [ ] Define Binance connector interface.
- [ ] Implement Binance public market data access through broker only.
- [ ] Implement Binance account snapshot through broker only.
- [ ] Implement Binance paper order simulation.
- [ ] Implement Binance live order placement behind `canary_live` policy.
- [ ] Implement Binance cancel order.
- [ ] Implement Binance order status polling.
- [ ] Enforce no-withdrawal API key requirement in docs and runtime checks where possible.
- [ ] Enforce subaccount/account allowlist.
- [ ] Enforce IP allowlist requirement in deployment docs.
- [ ] Add integration tests with mocked Binance API.
- [ ] Add optional sandbox/testnet tests if Binance environment supports required flow.

## Phase 8 - Ethereum Onchain Connector

- [ ] Define EVM connector interface.
- [ ] Implement Ethereum testnet RPC provider adapter.
- [ ] Implement transaction decoding.
- [ ] Implement ERC-20 approval detection.
- [ ] Implement unlimited approval rejection.
- [ ] Implement contract/function/token/spender allowlist checks.
- [ ] Implement transaction simulation.
- [ ] Implement expected balance delta comparison.
- [ ] Implement signer interface without exposing private keys to agent runtime.
- [ ] Implement local dev signer for testnet only.
- [ ] Add tests for unknown contract, known contract, approval, unlimited approval, and failed simulation.

## Phase 9 - Solana Onchain Connector

- [ ] Define Solana connector interface.
- [ ] Implement Solana testnet/devnet RPC provider adapter.
- [ ] Implement instruction parsing.
- [ ] Implement program allowlist checks.
- [ ] Implement token/account/authority checks.
- [ ] Implement simulation before signing.
- [ ] Implement expected balance delta comparison.
- [ ] Implement signer interface without exposing private keys to agent runtime.
- [ ] Implement local dev signer for testnet/devnet only.
- [ ] Add tests for unknown program, known program, authority change, token transfer, and failed simulation.

## Phase 10 - Secret And Signing Boundary

- [ ] Define secret provider interface.
- [ ] Implement local development secret provider.
- [ ] Choose first production-grade secret backend.
- [ ] Implement first production-grade secret provider adapter.
- [ ] Define signer backend interface.
- [ ] Implement local testnet signer backend.
- [ ] Document KMS adapter requirements.
- [ ] Document HSM adapter requirements.
- [ ] Document MPC adapter requirements.
- [ ] Add secret redaction utility for logs and errors.
- [ ] Add tests that secrets are not returned through agent-facing APIs.
- [ ] Add key rotation and emergency revocation runbook.

## Phase 11 - Reviewer Agent Layer

- [ ] Define reviewer prompt contract.
- [ ] Define reviewer input schema.
- [ ] Define reviewer output schema.
- [ ] Implement reviewer adapter interface.
- [ ] Implement first reviewer provider adapter.
- [ ] Ensure reviewer verdict is advisory, not final authorization.
- [ ] Add prompt injection detection labels.
- [ ] Add unsupported-claim detection labels.
- [ ] Add mismatch-between-evidence-and-action labels.
- [ ] Add tests for reviewer output parsing.
- [ ] Add fail-closed behavior for malformed reviewer output.

## Phase 12 - Agent Integrations

- [ ] Define common guarded tool surface.
- [ ] Implement OpenClaw adapter.
- [ ] Implement Hermes Agent adapter.
- [ ] Expose only guarded proposal/query tools.
- [ ] Prevent direct CEX tool exposure.
- [ ] Prevent direct RPC/signing tool exposure.
- [ ] Return structured reject reasons to agents.
- [ ] Add example OpenClaw strategy using guarded tools.
- [ ] Add example Hermes Agent strategy using guarded tools.
- [ ] Add end-to-end tests that both agents can propose valid intents.
- [ ] Add end-to-end tests that both agents cannot access keys or direct execution paths.

## Phase 13 - Runtime Isolation And Network Controls

- [ ] Create local Docker deployment profile.
- [ ] Run agent container as non-root.
- [ ] Drop unnecessary Linux capabilities.
- [ ] Add read-only mounts where feasible.
- [ ] Ensure Docker socket is not mounted into agent containers.
- [ ] Block host home directory, SSH keys, cloud credentials, browser profiles, and wallet files from agent mounts.
- [ ] Add egress proxy for agent runtime.
- [ ] Allowlist LLM providers.
- [ ] Allowlist guardrail service.
- [ ] Allowlist explicitly approved data sources.
- [ ] Block CEX APIs from agent containers.
- [ ] Block RPC endpoints from agent containers.
- [ ] Block metadata service endpoints.
- [ ] Block RFC1918/internal ranges by default.
- [ ] Log DNS and egress attempts.
- [ ] Document single VPS deployment profile.
- [ ] Document Kubernetes deployment profile.
- [ ] Document cloud-managed runtime deployment profile.
- [ ] Add tests or scripts that verify blocked egress paths.

## Phase 14 - Audit Log And Monitoring

- [ ] Implement append-only audit event writer.
- [ ] Include agent identity in audit events.
- [ ] Include prompt/session ID in audit events.
- [ ] Include input data references in audit events.
- [ ] Include normalized intent JSON in audit events.
- [ ] Include reviewer verdict in audit events.
- [ ] Include OPA input and output in audit events.
- [ ] Include dynamic risk check results in audit events.
- [ ] Include broker revalidation results in audit events.
- [ ] Include CEX order ID or transaction hash in audit events.
- [ ] Include human approval details in audit events.
- [ ] Add hash-chain or tamper-evidence design.
- [ ] Add tests for audit completeness on allow, deny, needs-human, and error flows.

## Phase 15 - Human Approval And Kill Switch

- [ ] Define human approval API.
- [ ] Define approval state machine.
- [ ] Implement approval timeout behavior.
- [ ] Implement approval audit logging.
- [ ] Implement configurable approval thresholds.
- [ ] Implement global kill switch.
- [ ] Implement per-agent kill switch.
- [ ] Implement per-account kill switch.
- [ ] Implement per-exchange kill switch.
- [ ] Implement per-chain kill switch.
- [ ] Add tests that live execution cannot bypass required approval.
- [ ] Add tests that kill switch blocks broker execution.

## Phase 16 - Limited Live Trading Gates

- [ ] Define `canary_live` policy bundle.
- [ ] Set tiny default canary notional.
- [ ] Require explicit configuration to enable live mode.
- [ ] Require Binance no-withdrawal key before live mode.
- [ ] Require Binance IP allowlist before live mode.
- [ ] Require audit log enabled before live mode.
- [ ] Require kill switch enabled before live mode.
- [ ] Require human approval for live mode until policy explicitly allows no-human low-risk trades.
- [ ] Add dry-run report before first live trade.
- [ ] Add post-trade reconciliation after first live trade.
- [ ] Add rollback procedure for live mode.

## Phase 17 - Red Team And Hardening

- [ ] Build prompt injection fixture suite.
- [ ] Test malicious webpage instructions.
- [ ] Test malicious repository instructions.
- [ ] Test malicious token metadata.
- [ ] Test malicious MCP/tool definitions.
- [ ] Test attempted secret exfiltration through prompts.
- [ ] Test attempted secret exfiltration through logs.
- [ ] Test attempted arbitrary egress.
- [ ] Test attempted direct CEX access from agent runtime.
- [ ] Test attempted direct RPC access from agent runtime.
- [ ] Test hallucinated price/balance/position claims.
- [ ] Test invalid reviewer output.
- [ ] Test malformed policy input.
- [ ] Test OPA unavailable.
- [ ] Test broker unavailable.
- [ ] Test signer unavailable.
- [ ] Test stale market data.
- [ ] Test stale portfolio data.
- [ ] Test unauthorized withdrawal.
- [ ] Test unauthorized transfer.
- [ ] Test unknown onchain contract.
- [ ] Test unlimited approval.
- [ ] Test Solana authority change.
- [ ] Test repeated rejection cooldown.
- [ ] Document findings and fixes.

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

- [ ] Run formatting checks.
- [ ] Run lint checks.
- [ ] Run TypeScript type checks.
- [ ] Run unit tests.
- [ ] Run integration tests with mocked CEX/RPC providers.
- [ ] Run Rego policy tests.
- [ ] Run end-to-end paper trading flow.
- [ ] Run Ethereum testnet simulation/signing flow.
- [ ] Run Solana testnet simulation/signing flow.
- [ ] Run agent integration tests for OpenClaw and Hermes.
- [ ] Run sandbox egress-block tests.
- [ ] Run secret redaction tests.
- [ ] Run audit completeness tests.

## Dependencies

- [ ] Choose package manager.
- [ ] Choose JSON Schema vs Zod for runtime validation.
- [ ] Choose OPA integration mode: local binary, sidecar, library, or policy bundle service.
- [ ] Choose first reviewer model/provider.
- [ ] Choose first production secret backend.
- [ ] Choose Binance library or implement signed REST client directly.
- [ ] Choose EVM library.
- [ ] Choose Solana library.
- [ ] Choose audit log storage backend.
- [ ] Choose container/network enforcement approach for local Docker.

## Open Questions

- [ ] Which package manager should the TypeScript monorepo use?
You can decide.
- [ ] Should schema validation use JSON Schema, Zod, or both?
You can decide.
- [ ] What is the first production-grade secret backend?
You can decide.
- [ ] Which reviewer model/provider should be used first?
gpt-5.5
- [ ] Which Binance account mode is in scope first: spot only, margin disabled, futures excluded?
Spot + Futures
- [ ] Which Ethereum testnet should be the first supported network?
You can decide.
- [ ] Which Solana environment should be the first supported network: devnet or testnet?
You can decide.
- [ ] What is the default tiny canary-live notional?
You can decide.
- [ ] What audit log backend should be used for MVP?
You can decide.
- [ ] What human approval surface should be used first: CLI, local web UI, Slack, Telegram, or GitHub issue/comment?
At the end we need to support CLI, local web UI, Slack, Telegram, Discord, WhatsApp, Signal.
