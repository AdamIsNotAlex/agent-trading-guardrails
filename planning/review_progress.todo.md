# Agent Trading Guardrails — Remediation Todo

Date: 2026-05-04
Source: `planning/review_progress.planning.md`

This checklist covers every over-marked or skipped task found during the Codex + Claude cross-review. Organized by priority tier, then by phase. Each item names the exact files to modify and what must change.

---

## P0 — Safety-Critical Gaps

These items would cause runtime failures, bypass safety checks, or leave the audit trail disconnected.

### P0.1 — Wire AuditWriter into GuardrailService (Phase 14 root cause)

The entire audit pipeline is disconnected from production flows. `GuardrailService` in `packages/guardrail-service/src/service.ts` never calls `AuditWriter.write()`. All audit writes in the test suite are synthetic.

- [x] Add `AuditWriter` as a constructor dependency in `packages/guardrail-service/src/service.ts` (alongside existing `reviewer`, `policy`, `risk` params at lines 24-31).
- [x] Emit `intent.received` audit event at the start of `evaluate()` (after intent validation, ~line 55), including normalized intent JSON and correlation ID.
- [x] Emit `reviewer.completed` audit event after reviewer verdict is obtained (~line 115), including the full `ReviewerVerdictSchema` in the `data` blob.
- [x] Emit `policy.evaluated` audit event after OPA evaluation (~line 150), including both `policyInput` and `policyOutput` in the `data` blob.
- [x] Emit `risk.evaluated` audit event after risk engine evaluation (~line 175), including `DynamicRiskResult` in the `data` blob.
- [x] Emit `decision.final` audit event before returning the `GuardrailDecision` (~line 215), including `outcome`, `reasons`, `requiresHumanApproval`, and the full decision.
- [x] Add `promptId` and `sessionId` optional fields to `AuditEventInput` in `packages/audit/src/writer.ts` (lines 7-14) and corresponding columns in `packages/audit/src/schema.ts`.
- [x] Add `inputRef` optional field to `AuditEventInput` for structured input data references.
- [x] Update `packages/guardrail-service/src/service.test.ts` to inject a real or spy `AuditWriter` and assert that all expected audit events are emitted for allow, deny, needs-human, and error flows.
- [x] Update audit completeness tests in `packages/audit/src/audit.test.ts` to assert field completeness (not just `toHaveLength(N)` row counts) — verify `promptId`, `reviewerVerdict`, `opaInput`, `riskChecks` are present and correct in the `data` blob.

### P0.2 — Wire human approval store into execution flow (Phases 15, 16)

The `ApprovalStore` exists in `packages/approval/src/store.ts` but is never checked by `GuardrailService` or `ExecutionBroker` during execution.

- [ ] Add `ApprovalStore` as a constructor dependency in `packages/guardrail-service/src/service.ts`.
- [ ] When `evaluate()` returns `outcome: "needs_human"`, automatically call `approvalStore.create(...)` with the intent details, escalation reason, and approval type.
- [ ] Add a `waitForApproval(approvalId, timeoutMs)` or polling mechanism so the service can gate execution on approval state.
- [ ] In `packages/broker/src/broker.ts`, add a check that when the `GuardrailDecision.outcome` was originally `"needs_human"`, verify that an approval with state `"approved"` exists before proceeding to execution (the broker already rejects non-`"allow"` outcomes at line 35-43, but needs to handle the approval-granted-after-escalation flow).
- [ ] Emit `approval.requested`, `approval.approved`, `approval.denied`, and `approval.timeout` audit events from the approval flow.
- [ ] Add test in `packages/approval/src/approval.test.ts` that verifies broker rejects execution when approval is missing (not just that a request has `state === "pending"`).
- [ ] Add test that proves the end-to-end path: agent proposes intent → service escalates to `needs_human` → approval created non-interactively → human approves → execution proceeds.

### P0.3 — Implement simulation before signing in Solana connector (Phase 9)

The signing path in `packages/solana-connector/src/connector.ts` lines 69-74 calls `signer.signAndBroadcast(instructions)` directly without calling `provider.simulateTransaction(instructions)` first. This is a core safety bypass.

- [x] In `packages/solana-connector/src/connector.ts`, add `const simResult = await this.provider.simulateTransaction(instructions)` before `this.signer.signAndBroadcast(instructions)` in the `onchain.request_signature` branch (lines 69-74).
- [x] If `simResult.success === false`, return a failed result without calling `signAndBroadcast`.
- [x] Add test in `packages/solana-connector/src/connector.test.ts` that verifies `onchain.request_signature` calls `simulateTransaction` before `signAndBroadcast` (mock provider should receive the simulation call).
- [x] Add test that signing is rejected when simulation fails.

### P0.4 — Fix Rego↔TypeScript schema mismatch (Phase 4)

Rego outputs `snake_case` field names (`requires_human_approval`, `matched_allow_rules`, `matched_deny_rules`) while `PolicyOutput` in `packages/schemas/src/policy.ts` expects `camelCase` (`requiresHumanApproval`, `matchedAllowRules`, `matchedDenyRules`). Additionally, Rego does not emit `evaluatedAt`. `PolicyOutputValidator.parse(rawPolicy)` at `service.ts:202` would fail at runtime.

- [x] Create a `transformOpaOutput(raw: Record<string, unknown>): PolicyOutput` function in a new file `packages/guardrail-service/src/opa-transform.ts` that:
  - Maps `requires_human_approval` → `requiresHumanApproval`
  - Maps `matched_allow_rules` → `matchedAllowRules`
  - Maps `matched_deny_rules` → `matchedDenyRules`
  - Maps `hard_deny_reasons` + `escalation_reasons` → `reasons` array
  - Injects `evaluatedAt: new Date().toISOString()`
- [x] Call `transformOpaOutput` in `packages/guardrail-service/src/service.ts` before `PolicyOutputValidator.parse(...)`.
- [x] Add unit tests for the transform function covering all output permutations.
- [x] Add integration test that passes real Rego output (from `opa eval`) through the transform and validates against `PolicyOutputValidator`.

### P0.5 — Populate daily risk facts into OPA policy input (Phase 4)

`dailyNotionalUsd` and `dailyRealizedLossUsd` are never populated in `policyInput` by `packages/guardrail-service/src/service.ts`, making the Rego rules in `escalation.rego` lines 16-28 dead code.

- [x] In `packages/guardrail-service/src/service.ts`, after obtaining the `DynamicRiskResult` from the risk engine, extract `dailyNotionalUsd` and `dailyRealizedLossUsd` from the risk facts and include them in the `policyInput` object passed to `policy.evaluate(policyInput)`.
- [x] Ensure the risk engine's `DailyStats` (from `packages/risk-engine/src/providers.ts`) is accessible to the service for populating these fields — may require the risk engine to expose the raw `DailyStats` alongside its pass/fail result.
- [x] Add test that verifies `policyInput` passed to OPA contains `dailyNotionalUsd` and `dailyRealizedLossUsd` when daily stats are available.
- [x] Add test that verifies OPA escalation rules fire correctly when daily limits are exceeded.

### P0.6 — Fix `needs_human` scoping bug in escalation.rego (Phase 4)

`requires_human_by_policy` in `packages/policy/src/rules/escalation.rego` lines 43-48 fires if ANY allowlist entry has `requiresHumanApproval: true`, regardless of whether that entry matches the current request.

- [x] Modify `requires_human_by_policy` in `packages/policy/src/rules/escalation.rego` to additionally check that the matching allowlist entry's `principal`, `action`, and `resource` match `input.principal`, `input.action`, and `input.resource` (or use the same matching logic as `allowlist.rego`).
- [x] Add Rego test: an allowlist entry with `requiresHumanApproval: true` for agent A does NOT escalate a request from agent B.
- [x] Add Rego test: an allowlist entry with `requiresHumanApproval: true` for `cex.place_order` does NOT escalate a `cex.cancel_order` request.

---

## P1 — Functional Gaps

These items are needed for the system to work end-to-end against real infrastructure.

### P1.1 — Implement concrete EVM RPC provider (Phase 8)

`EvmRpcProvider` in `packages/evm-connector/src/interfaces.ts` lines 29-33 is interface-only. No `viem`/`ethers` dependency exists.

- [ ] Add `viem` as a dependency to `packages/evm-connector/package.json`.
- [ ] Create `packages/evm-connector/src/sepolia-provider.ts` implementing `EvmRpcProvider`:
  - [ ] `simulateTransaction()` → use `viem` `simulateContract` or `eth_call` against Sepolia RPC.
  - [ ] `getBalance()` → use `viem` `getBalance`.
  - [ ] `getBlockNumber()` → use `viem` `getBlockNumber`.
- [ ] Accept RPC URL via constructor config (not hardcoded).
- [ ] Add integration test with a mock HTTP server or Sepolia testnet (env-gated).

### P1.2 — Implement concrete Solana RPC provider (Phase 9)

`SolanaRpcProvider` in `packages/solana-connector/src/interfaces.ts` lines 22-26 is interface-only. `@solana/web3.js` is not a declared dependency.

- [ ] Add `@solana/web3.js` as a dependency to `packages/solana-connector/package.json`.
- [ ] Create `packages/solana-connector/src/devnet-provider.ts` implementing `SolanaRpcProvider`:
  - [ ] `simulateTransaction()` → use `@solana/web3.js` `simulateTransaction`.
  - [ ] `getBalance()` → use `getBalance`.
  - [ ] `getSlot()` → use `getSlot`.
- [ ] Accept RPC URL via constructor config.
- [ ] Add integration test with a mock or devnet (env-gated).

### P1.3 — Implement concrete OPA HTTP PolicyEvaluator (Phase 4)

No concrete implementation of `PolicyEvaluator` (defined in `packages/guardrail-service/src/interfaces.ts` lines 13-16) exists. Tests use mocks only.

- [ ] Create `packages/guardrail-service/src/opa-evaluator.ts` implementing `PolicyEvaluator`:
  - [ ] `evaluate(input)` → HTTP POST to `${opaUrl}/v1/data/guardrails/main` with `{ input }`, parse response.
  - [ ] `isHealthy()` → HTTP GET to `${opaUrl}/health`, return `true` if 200.
- [ ] Apply the `transformOpaOutput` from P0.4 inside `evaluate()` before returning.
- [ ] Accept OPA URL from config (default `http://localhost:8181`).
- [ ] Add integration test that starts OPA (or mocks HTTP) and verifies the full evaluate→transform→parse pipeline.

### P1.4 — Implement concrete OpenAI LLM provider (Phase 11)

No concrete `OpenAiLlmProvider` HTTP client exists. `ReviewerAdapter` accepts a generic `LlmProvider` interface.

- [ ] Add `openai` SDK as a dependency to `packages/reviewer/package.json`.
- [ ] Create `packages/reviewer/src/openai-provider.ts` implementing `LlmProvider`:
  - [ ] Accept API key via constructor (from secret provider, not hardcoded).
  - [ ] Call OpenAI chat completions with model `gpt-5.5` and the reviewer prompt.
  - [ ] Parse response into the expected reviewer output format.
- [ ] Add test with mocked HTTP for response parsing.
- [ ] Ensure API key is never logged or returned to agent-facing APIs.

### P1.5 — Implement balance delta comparison for EVM and Solana (Phases 8, 9)

`SimulationResult.balanceChanges` and `SolanaSimulationResult.balanceChanges` exist as types but no comparison logic exists.

- [ ] Create `packages/evm-connector/src/balance-delta.ts`:
  - [ ] Accept `SimulationResult.balanceChanges` and `expectedDeltas: {address, asset, minDelta, maxDelta}[]`.
  - [ ] Return pass/fail with structured reasons for each mismatch.
- [ ] Call balance delta comparison in `packages/evm-connector/src/connector.ts` after simulation, before signing.
- [ ] Create equivalent `packages/solana-connector/src/balance-delta.ts` for Solana.
- [ ] Call balance delta comparison in Solana connector after simulation (once P0.3 is done).
- [ ] Add tests for exact match, within tolerance, and out-of-range scenarios in both packages.

### P1.6 — Wire `assertNotVaultDevInProduction` into runtime startup (Phase 10)

`packages/secrets/src/env-guard.ts` exports the guard but it is never called from runtime code.

- [x] Call `assertNotVaultDevInProduction(environment, vaultAddr)` from `packages/guardrail-service/src/config.ts` during config loading (or from the service constructor).
- [x] Also call it from `packages/broker/src/broker.ts` constructor or config validation.
- [x] Fix the guard to also check for `localhost:8200` (not just `127.0.0.1:8200`) in `packages/secrets/src/env-guard.ts` line 8.
- [x] Add test that `localhost:8200` is also rejected in production environments.

### P1.7 — Wire `redactSecrets` into broker error logging (Phase 10)

`packages/broker/src/broker.ts` line 127 writes `data: { error: String(err) }` without redaction.

- [x] Import `redactSecrets` from `@guardrails/secrets` in `packages/broker/src/broker.ts`.
- [x] Change line 127 from `error: String(err)` to `error: redactSecrets(String(err))`.
- [x] Audit all other `String(err)` or `err.message` usages in the broker and guardrail-service for unredacted secret leakage.
- [x] Add test that an error containing a private key pattern is redacted in the audit event.

### P1.8 — Implement Binance order status polling (Phase 7)

`BinanceApiClient.getOrderStatus()` and `BinancePaperSimulator.getOrderStatus()` exist but the connector never exposes or calls them.

- [ ] Add `getOrderStatus(params: OrderStatusParams): Promise<BinanceOrderResult>` as a public method on `BinanceConnector` in `packages/binance-connector/src/connector.ts`.
- [ ] Dispatch to `this.client.getOrderStatus(params)`.
- [ ] Add a `cex.get_order_status` action case in the connector's `execute()` method.
- [ ] Add test for order status retrieval in `packages/binance-connector/src/connector.test.ts`.

### P1.9 — Add `reviewerRiskLevel` check to auto-execution policy (Phase 4)

`main.rego` auto-allows reviewer-approved allowlist matches without checking `reviewerRiskLevel`. A high/critical risk input can auto-allow.

- [x] In `packages/policy/src/main.rego`, add a condition to the `"allow"` decision rule: `input.reviewerRiskLevel == "low"` (or `input.reviewerRiskLevel` is in `{"low", "medium"}` depending on policy intent).
- [x] Add Rego test: reviewer approves with `riskLevel: "high"` → decision is `"needs_human"`, not `"allow"`.
- [x] Add Rego test: reviewer approves with `riskLevel: "low"` → decision is `"allow"` when other conditions are met.

### P1.10 — Implement concrete BrokerIdempotencyStore (Phase 6)

`BrokerIdempotencyStore` is interface-only — no concrete exported implementation, no conflict detection.

- [x] Create `packages/broker/src/idempotency-store.ts` exporting `InMemoryBrokerIdempotencyStore` implementing `BrokerIdempotencyStore`.
- [x] Implement payload-hash conflict detection: if the same `idempotencyKey` is submitted with a different intent payload hash, return a conflict error.
- [x] Add configurable retention/TTL for idempotency entries.
- [x] Add tests for replay (same key, same payload → return cached result), conflict (same key, different payload → error), and TTL expiry.

### P1.11 — Add devnet/testnet-only guards to dev signers (Phases 8, 9)

`LocalDevSigner` (EVM) and `LocalDevSolanaSigner` (Solana) have no environment guards.

- [x] In `packages/evm-connector/src/dev-signer.ts`, add a constructor check: if `config.chainEnvironment` is `"mainnet"`, throw an error refusing to instantiate.
- [x] In `packages/solana-connector/src/dev-signer.ts`, add the same guard for non-devnet environments.
- [x] Add tests that instantiation throws for mainnet/production environments.

### P1.12 — Implement durable allowlist onboarding (Phase 15)

Approving an `allowlist_onboarding` request does nothing — no policy change, no audit event.

- [x] When `ApprovalStore.approve()` is called on an `allowlist_onboarding` request, trigger a callback/hook that:
  - [x] Writes the new allowlist entry to a durable store (e.g., appends to a policy config file or database).
  - [x] Emits an `allowlist.updated` audit event via `AuditWriter`.
- [x] Add test that approving an `allowlist_onboarding` request emits the audit event and persists the policy change.

---

## P2 — Completeness Gaps

These items close out checklist accuracy, improve test quality, and fill documentation holes.

### P2.1 — Generate Drizzle Kit migration files (Phase 14)

`drizzle.config.ts` references `packages/audit/drizzle/` but the directory is empty.

- [ ] Run `pnpm drizzle-kit generate` to produce migration SQL from `packages/audit/src/schema.ts`.
- [ ] Verify generated migration creates the `audit_events` table with all columns including `prompt_id` and `session_id` (added in P0.1).
- [ ] Update `packages/audit/src/writer.ts` `initSchema()` to use Drizzle Kit migrations instead of raw `CREATE TABLE IF NOT EXISTS` SQL.
- [ ] Update the migration test in `packages/audit/src/audit.test.ts` to apply the Drizzle migration from an empty database (not the raw SQL fallback).

### P2.2 — Add example strategies for OpenClaw and Hermes (Phase 12)

No example strategy files exist in the repo.

- [ ] Create `examples/openclaw-strategy.ts` demonstrating how an OpenClaw agent uses guarded tools to propose a Binance spot order, handle rejection, and react to `needs_human` escalation.
- [ ] Create `examples/hermes-strategy.ts` demonstrating how a Hermes Agent uses guarded tools for an onchain simulation followed by a signing request.
- [ ] Both examples should import from the adapter packages and use only the guarded tool surface — no direct CEX/RPC access.

### P2.3 — Implement live trading preflight gates (Phase 16)

Most live trading safety gates are docs-only with no enforcement code.

- [ ] Create `packages/broker/src/preflight.ts` with a `LiveModePreflightCheck` that validates before the first live trade:
  - [ ] Audit log is healthy and writable (call `AuditWriter.write()` with a test event and verify).
  - [ ] Kill switch is initialized and reachable.
  - [ ] Human approval is configured and the approval store is accessible.
- [ ] Add a `validateNoWithdrawalKey` check stub in `packages/binance-connector/src/validation.ts` — at minimum, document that this requires checking the Binance API key permissions endpoint (`GET /sapi/v1/account/apiRestrictions`), and implement the check if the endpoint is available.
- [ ] Add an `ipAllowlist` config field to `BinanceConnector` config — validate that it is non-empty before enabling live mode.
- [ ] Implement dry-run report: before the first live trade, execute the full pipeline (validate → review → policy → risk → broker revalidate) with `dryRun: true` and output a summary report without executing.
- [ ] Implement post-trade reconciliation: after the first live trade, call `getOrderStatus` (from P1.8) and compare the execution result against the expected outcome, log any discrepancies.
- [ ] Set futures-specific daily notional cap to USD 25 in `packages/policy/src/policy.json` — add a `futures_auto_max_daily_notional_usd: 25` field under `canary_live` limits and reference it in `escalation.rego` for `usdm_futures` actions.

### P2.4 — Strengthen red-team test assertions (Phase 17)

Prompt injection tests at lines 116, 123, 130, 387 of `packages/red-team/src/red-team.test.ts` only assert `result.intentId` is truthy — never `outcome === "deny"`.

- [ ] Change line 116 (webpage injection test): add `expect(result.outcome).toBe("deny")` or at minimum verify `result.outcome !== "allow"`.
- [ ] Change line 123 (repo injection test): same fix.
- [ ] Change line 130 (token metadata test): same fix.
- [ ] Change line 387 (hallucinated price test): same fix.
- [ ] If the guardrail service currently returns `"allow"` for these injection payloads (meaning the tests were masking real failures), investigate and fix the detection logic.

### P2.5 — Add missing red-team tests (Phase 17)

Fixtures exist for MCP/tool definitions, log exfiltration, and hallucinated balance/position, but no tests use them.

- [ ] Add test using `promptInjectionPayloads.mcpToolDefinition` from `packages/red-team/src/fixtures.ts` — embed the MCP tool definition in an intent's `rationale` or `evidence` field and assert `outcome === "deny"`.
- [ ] Add test using `promptInjectionPayloads.secretExfiltrationLog` — submit the payload and verify that log output (captured via a spy or interceptor) does not contain secret patterns.
- [ ] Add test using `hallucinatedClaims.fakeBalance` — submit an intent with a hallucinated balance and assert the risk engine rejects it (or that the service detects the discrepancy against live data).
- [ ] Add test using `hallucinatedClaims.fakePosition` — same pattern.

### P2.6 — Write Phase 17 findings/fixes document (Phase 17)

No findings document exists from the red-team exercise.

- [ ] Create `docs/red-team-findings.md` documenting:
  - [ ] Which attack vectors were tested and their outcomes.
  - [ ] Which gaps were found (weak assertions, unused fixtures, missing tests).
  - [ ] What fixes were applied (reference commits or this remediation plan).
  - [ ] Residual risks and recommended future hardening.

### P2.7 — Add DNS logging to egress proxy (Phase 13)

DNS-level logging is completely absent. HTTP access logs write to ephemeral tmpfs only.

- [ ] Add a DNS logging sidecar or configure the egress proxy's DNS resolution to log queries (e.g., use `dnsmasq` as a local resolver with query logging, or a CoreDNS sidecar).
- [ ] Mount a persistent volume or configure log shipping for nginx access/error logs (currently writing to `/tmp` tmpfs in the container).
- [ ] Update `deploy/docker/nginx-egress.conf` or `docker-compose.yml` accordingly.

### P2.8 — Add integration test files (Phases 1, 7, 12)

`vitest.integration.config.ts` and the CI step exist, but zero `*.integration.test.ts` files exist.

- [ ] Create `packages/binance-connector/src/binance.integration.test.ts` with mocked Binance REST API (HTTP-level mocking, not class-level mocks) testing the full connector flow.
- [ ] Create `packages/agent-adapters/src/adapters.integration.test.ts` testing adapters against a real (mocked-infrastructure) guardrail service stack — not just class-level mocks.
- [ ] Optionally create `packages/evm-connector/src/evm.integration.test.ts` and `packages/solana-connector/src/solana.integration.test.ts` once concrete RPC providers exist (P1.1, P1.2).

### P2.9 — Add missing kill switch tests (Phase 15)

Per-account and per-chain kill switches have code but zero test coverage.

- [ ] Add test in `packages/broker/src/broker.test.ts`: activate per-account kill switch → broker rejects execution for that account.
- [ ] Add test: activate per-chain kill switch → broker rejects execution for that chain.
- [ ] Add test: per-account kill switch does NOT block a different account.
- [ ] Add test: per-chain kill switch does NOT block a different chain.

### P2.10 — Emit `killswitch.activated` audit event (Phase 6)

`killswitch.activated` exists in the audit event schema but is never emitted.

- [ ] In `packages/broker/src/kill-switch.ts` `activate()` method, call `AuditWriter.write()` with `eventType: "killswitch.activated"` and the scope details.
- [ ] This requires adding `AuditWriter` as a dependency to `InMemoryKillSwitch` (or emitting via an event/callback pattern).
- [ ] Add test that activating a kill switch emits the audit event.

### P2.11 — Add Solana `instructionType` to PolicyInput (Phase 4)

The hard-deny rule for Solana authority changes in `packages/policy/src/rules/deny.rego` lines 46-50 references `input.instructionType`, but this field is absent from `PolicyInput` and never populated.

- [ ] Add `instructionType?: string` to `PolicyInput` in `packages/schemas/src/policy.ts`.
- [ ] Populate `instructionType` in `packages/guardrail-service/src/service.ts` when the action is `onchain.request_signature` and the chain is Solana — extract from the parsed instructions.
- [ ] Add Rego test that a Solana `setAuthority` instruction type triggers the hard-deny rule.

### P2.12 — Add Binance USD-M futures isolated-mode enforcement (Phase 7)

Leverage cap is enforced, but no `marginType`/`ISOLATED` field exists anywhere.

- [ ] Add `marginType?: "isolated" | "cross"` field to the CEX order intent schema in `packages/schemas/src/intent.ts`.
- [ ] In `packages/binance-connector/src/validation.ts`, for `usdm_futures` intents, require `marginType === "isolated"` and reject `"cross"`.
- [ ] Add `marginType` to `PolicyInput` and add a Rego rule enforcing isolated-mode in canary-live.
- [ ] Add test that cross-margin futures intents are rejected.

### P2.13 — Add guarded adapter surface for `onchain.request_signature` and `onchain.get_portfolio` (Phase 12)

These schema-defined actions are not covered by the adapter tool surface.

- [ ] In `packages/agent-adapters/src/guarded-tools.ts`, add guarded tool definitions for `onchain.request_signature` and `onchain.get_portfolio`.
- [ ] Wire them in both `packages/agent-adapters/src/openclaw-adapter.ts` and `packages/agent-adapters/src/hermes-adapter.ts`.
- [ ] Add tests that both adapters expose and correctly route these tools.

### P2.14 — Improve Vault deployment documentation (Phase 10)

Docs are summary-level only for all three Vault profiles.

- [ ] Expand `docs/deployment-profiles.md` "Single VPS" section with concrete Vault config (storage stanza, listener stanza, unseal steps, backup cron).
- [ ] Expand "Kubernetes" section with example Helm values for `vault-helm`, Raft HA config, anti-affinity, and PVC sizing.
- [ ] Expand "Cloud-Managed Runtime" section with HCP Vault setup steps, Terraform example, and IAM role binding.

### P2.15 — Add price band check to risk engine (Phase 5)

Only slippage is implemented. No price-band check compares intent target price against live market price.

- [ ] Add `maxPriceBandBps: number` to `RiskLimits` in `packages/risk-engine/src/config.ts`.
- [ ] Add `checkPriceBand()` in `packages/risk-engine/src/checks.ts` that compares `intent.price` against `marketData.price` and fails if the deviation exceeds `maxPriceBandBps`.
- [ ] Wire the check into the risk engine orchestrator.
- [ ] Add default value to `DEFAULT_CANARY_LIVE_LIMITS`.
- [ ] Add tests for price within band, price outside band, and missing market data (fail-closed).

### P2.16 — Add max-orders-per-day limit to risk engine (Phase 5)

`DailyStats.orderCount` exists in `packages/risk-engine/src/providers.ts` line 18 but is never used.

- [ ] Add `maxOrdersPerDay: number` to `RiskLimits` in `packages/risk-engine/src/config.ts`.
- [ ] In `checkOrderFrequency()` (or a new `checkDailyOrderCount()`) in `packages/risk-engine/src/checks.ts`, read `stats.orderCount` and fail if it exceeds `maxOrdersPerDay`.
- [ ] Add default value to `DEFAULT_CANARY_LIVE_LIMITS`.
- [ ] Add test for order count within limit and exceeding limit.

### P2.17 — Add HTTP server layer for GuardrailService (Phase 3)

The service has in-process methods only — no HTTP endpoints despite tasks saying "endpoint."

- [ ] Create `packages/guardrail-service/src/server.ts` with a lightweight HTTP server (e.g., Hono or Fastify):
  - [ ] `GET /health` → calls `service.health()`.
  - [ ] `POST /evaluate` → accepts intent JSON body, calls `service.evaluate()`, returns `GuardrailDecision`.
- [ ] Add request validation middleware using the Zod schemas.
- [ ] Add correlation ID injection from request headers or auto-generated.
- [ ] Add test for HTTP endpoint responses.

### P2.18 — Add Binance sandbox/testnet tests (Phase 7)

No testnet/sandbox test flow exists.

- [ ] Create `packages/binance-connector/src/binance.sandbox.test.ts` gated behind an env variable (e.g., `BINANCE_TESTNET_API_KEY`).
- [ ] Test spot order placement and cancellation against Binance testnet (`testnet.binance.vision`).
- [ ] Skip gracefully when env var is not set (CI skips, local dev can opt-in).

### P2.19 — Add position delta failure-path test (Phase 5)

`checkPositionDelta` exists but has no dedicated failure test.

- [ ] Add test in `packages/risk-engine/src/engine.test.ts` where the position delta exceeds `maxPositionDeltaPct` and verify the check returns a failure result.

### P2.20 — Add LLM provider and data source entries to nginx egress config (Phase 13)

Only the guardrail service is allowlisted in `deploy/docker/nginx-egress.conf`.

- [ ] If agents need direct LLM access: add `upstream` entries for OpenAI (`api.openai.com`) and Anthropic (`api.anthropic.com`) with corresponding `location` blocks.
- [ ] If agents do NOT need direct LLM access (routed through guardrail): document this architectural decision explicitly in `docs/security-boundaries.md`.
- [ ] For approved data sources: add template `location` blocks with comments showing where price feed / market data API upstreams would go.

---

## Dependencies Between Tasks

```
P0.1 (AuditWriter in service) ← P0.2 (approval audit events)
P0.1 (AuditWriter in service) ← P2.1 (Drizzle migration for new columns)
P0.1 (AuditWriter in service) ← P2.10 (killswitch.activated event)
P0.3 (Solana simulation) ← P1.5 (balance delta comparison)
P0.4 (Rego↔TS transform) ← P1.3 (OPA HTTP evaluator)
P1.1 (EVM RPC provider) ← P2.8 (integration tests)
P1.2 (Solana RPC provider) ← P2.8 (integration tests)
P1.8 (order status polling) ← P2.3 (post-trade reconciliation)
P1.12 (durable allowlist) ← P0.2 (approval flow wired)
P2.11 (instructionType in PolicyInput) ← P0.6 (escalation scoping fix)
P2.12 (isolated-mode field) ← P2.3 (live trading gates)
```

## Suggested Implementation Order

1. **P0.4** (Rego↔TS transform) — unblocks P1.3
2. **P0.6** (escalation scoping fix) — standalone Rego fix
3. **P0.5** (daily risk facts) — standalone service.ts fix
4. **P0.1** (AuditWriter wiring) — large but high-value
5. **P0.3** (Solana simulation before signing) — standalone connector fix
6. **P0.2** (approval flow wiring) — depends on P0.1
7. **P1.6** (Vault guard in runtime) — quick win
8. **P1.7** (redact secrets in broker) — quick win
9. **P1.9** (reviewerRiskLevel check) — standalone Rego fix
10. **P1.10** (BrokerIdempotencyStore) — standalone
11. **P1.11** (dev signer guards) — quick win
12. **P1.1** (EVM RPC provider) — enables integration tests
13. **P1.2** (Solana RPC provider) — enables integration tests
14. **P1.3** (OPA HTTP evaluator) — depends on P0.4
15. **P1.4** (OpenAI LLM provider) — standalone
16. **P1.5** (balance delta comparison) — depends on P0.3
17. **P1.8** (Binance order status) — enables P2.3
18. **P1.12** (durable allowlist onboarding) — depends on P0.2
19. **P2.x** items in any order, prioritizing P2.3 (live gates) and P2.4 (red-team assertions)
