# Agent Trading Guardrails — Implementation Review

Date: 2026-05-04
Reviewer: Codex CLI (gpt-5.5 xhigh) + Claude Opus 4.6 cross-verification
Source: `planning/init.todo.md`

## Summary

| Phase | Tasks | Done | Partial | Missing | Score |
|-------|-------|------|---------|---------|-------|
| **0** Spec & Threat Model | 16 | 11 | 5 | 0 | 69% |
| **1** Repository & Tooling | 17 | 16 | 1 | 0 | 94% |
| **2** Schemas & Core Types | 17 | 17 | 0 | 0 | 100% |
| **3** Guardrail Service MVP | 14 | 11 | 3 | 0 | 79% |
| **4** OPA/Rego Policy Layer | 30 | 19 | 11 | 0 | 63% |
| **5** Dynamic Risk Engine | 13 | 8 | 5 | 0 | 62% |
| **6** Broker MVP | 9 | 4 | 5 | 0 | 44% |
| **7** Binance Connector | 17 | 7 | 8 | 2 | 41% |
| **8** EVM Connector | 11 | 6 | 2 | 3 | 55% |
| **9** Solana Connector | 10 | 5 | 2 | 3 | 50% |
| **10** Secrets & Signing | 17 | 12 | 5 | 0 | 71% |
| **11** Reviewer Agent | 11 | 10 | 1 | 0 | 91% |
| **12** Agent Integrations | 11 | 6 | 3 | 2 | 55% |
| **13** Runtime Isolation | 19 | 16 | 3 | 0 | 84% |
| **14** Audit Log | 15 | 3 | 9 | 3 | 20% |
| **15** Human Approval | 27 | 14 | 8 | 5 | 52% |
| **16** Live Trading Gates | 13 | 3 | 6 | 4 | 23% |
| **17** Red Team | 29 | 22 | 5 | 2 | 76% |
| **TOTAL** | **296** | **190** | **82** | **24** | **64%** |

## Top Systemic Issues (cross-cutting)

1. **`GuardrailService` never calls `AuditWriter`** — all audit writes in tests are synthetic. Root cause of Phase 14's 20% score.
2. **No concrete RPC providers** for EVM or Solana — `EvmRpcProvider` and `SolanaRpcProvider` are interfaces only; `viem` and `@solana/web3.js` are not declared dependencies.
3. **No concrete OPA HTTP `PolicyEvaluator`** — plus Rego outputs snake_case while `PolicyOutput` expects camelCase; no transformation exists. Would fail at runtime.
4. **Daily risk facts (`dailyNotionalUsd`, `dailyRealizedLossUsd`) never fed to OPA** — Rego rules referencing them are dead code.
5. **Human approval store not wired into execution flow** — approvals exist in isolation but broker and service do not check them.
6. **Phase 16 "completion" commit only changed the todo file** — most live trading gates (dry-run report, post-trade reconciliation, no-withdrawal key check, IP allowlist check) are documentation only with no enforcement code.

---

## Phase 0 — Spec And Threat Model

**Score: 11/16 fully implemented, 5 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Define explicitly denied actions for MVP (bridge transaction without human approval) | PARTIAL | Bridge transaction denial is documented in `docs/threat-model.md` but has no detection or routing code in any package. |
| Define automatic execution envelope | PARTIAL | Documented and mostly in Rego, but `reviewerRiskLevel == low` is not explicitly enforced in policy — only reviewer approval + allowlist checks are enforced. |
| Define `needs_human` escalation criteria | PARTIAL | Documented but only a subset is in `packages/policy/src/rules/escalation.rego` — prompt-injection-triggered escalation and time-of-day/novel-contract escalation from the threat model doc are absent from code. |
| Define hard-deny criteria | PARTIAL | Hard-deny precedence exists in `main.rego` and `deny.rego`, but prompt injection as a hard-deny trigger is only in the reviewer agent's LLM prompt (`packages/reviewer/src/prompt.ts`), not a structural Rego rule that survives reviewer bypass. |
| Define idempotency strategy | PARTIAL | Guardrail-service level idempotency is solid. Connector-level idempotency tracking (EVM/Solana), configurable retention windows, and durable storage are absent. |

### Skipped tasks

None — all tasks are checked.

---

## Phase 1 — Repository And Tooling

**Score: 16/17 fully implemented, 1 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Add integration test structure | PARTIAL | `vitest.integration.config.ts` exists and the CI step is wired, but zero actual `*.integration.test.ts` files exist in the repo. |

### Skipped tasks

None.

---

## Phase 2 — Schemas And Core Types

**Score: 17/17 fully implemented**

All tasks verified. No issues found.

Minor note: `generate-json-schema.ts` references `cex-get-open-orders-intent`, `cex-get-portfolio-intent`, and `onchain-query-intent` JSON artifacts that are not present in `packages/schemas/json-schema/`. Not a Phase 2 task gap but would cause stale output if the generator is re-run.

---

## Phase 3 — Guardrail Service MVP

**Score: 11/14 fully implemented, 3 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Add health endpoint | PARTIAL | `GuardrailService.health()` method exists but no HTTP server — no Express/Fastify/Hono; just an in-process method. |
| Add intent validation endpoint | PARTIAL | Validation via `TradingIntent.safeParse()` inside `evaluate()`, but no standalone HTTP endpoint. |
| Add final decision endpoint | PARTIAL | Decision returned from `evaluate()` return value, but no HTTP endpoint. |

All three share the same root cause: the service is implemented as an in-process library, not as an HTTP service. Could be intentional if the service is designed to be embedded in a host application, but the tasks say "endpoint."

### Skipped tasks

None.

---

## Phase 4 — OPA/Rego Policy Layer

**Score: 19/30 fully implemented, 11 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement default deny | PARTIAL | `default decision := "deny"` is present, but `escalation.rego` makes any unmatched allowlist case emit `needs_human` rather than `deny`, softening the true deny-by-default semantic. |
| Implement allowlist schema (principal/action/resource/condition) | PARTIAL | `policy.json` uses the correct shape and `allowlist.rego` consumes it, but no JSON Schema or Zod validator enforces the allowlist entry structure — shape violations would silently produce incorrect behavior. |
| Implement automatic execution for reviewer-approved low-risk allowlisted actions | PARTIAL | `main.rego` auto-allows reviewer-approved allowlist matches, but `reviewerRiskLevel` field (exists in `PolicyInput`) is never checked. A reviewer-approved high/critical risk input can auto-allow. |
| Implement `needs_human` policy | PARTIAL | `requires_human_by_policy` in `escalation.rego` is global, not scoped to the matching allowlist entry. Any entry with `requiresHumanApproval: true` would escalate unrelated requests. |
| Implement Binance daily notional limit policy | PARTIAL | Rego rules reference `dailyNotionalUsd` but `packages/guardrail-service/src/service.ts` never populates this field in `policyInput`. Rules are dead code at runtime. |
| Implement Binance daily loss limit policy | PARTIAL | Same issue — `dailyRealizedLossUsd` never populated. Dead code. |
| Implement Ethereum contract/function/token/spender allowlist | PARTIAL | Only contract address allowlisting is in Rego. Function selector, token, and spender allowlisting are in the EVM connector layer, not in OPA. |
| Implement Solana program/instruction/token/account allowlist | PARTIAL | Only program allowlisting is in Rego. Instruction type, token mint, and account allowlisting are in the Solana connector, not OPA. |
| Implement Solana authority-change denial or human approval | PARTIAL | Hard-deny rule exists in `deny.rego`, but `instructionType` is absent from `PolicyInput` schema and never populated. Rule cannot be reached. |
| Add policy fixtures for dev/paper/testnet/canary_live | PARTIAL | All environment data is embedded in one `policy.json` rather than separate fixture files per environment. |
| Document TS normalization and live risk facts feeding OPA | PARTIAL | `packages/policy/README.md` documents the intended flow, but `service.ts` does not feed daily risk facts into OPA, making the documentation partially inaccurate. |

### Additional issues found (outside task list)

- No concrete OPA HTTP `PolicyEvaluator` implementation exists — only an injected interface.
- Rego output shape (`snake_case`) is incompatible with `PolicyOutput` schema (`camelCase`). `PolicyOutputValidator.parse(rawPolicy)` would fail at runtime without a transformation layer.

### Skipped tasks

None.

---

## Phase 5 — Dynamic Risk Engine

**Score: 8/13 fully implemented, 5 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement slippage and price band check | PARTIAL | Only slippage (`maxSlippageBps`) is implemented. No price-band check comparing intent target price against live `MarketDataSnapshot.price`. `RiskLimits` has no `maxPriceBandBps` field. |
| Implement position delta check | PARTIAL | Check exists but has no dedicated failure-path test. |
| Implement order frequency and cooldown check | PARTIAL | `DailyStats.orderCount` exists but is completely unused. Only minimum time interval (`minOrderIntervalMs`) is enforced — no max-orders-per-day limit. |
| Implement unknown data fail-closed result | PARTIAL | Market/portfolio/daily stats are fail-closed, but `getLastOrderTimestampMs()` returning `null` passes through (first order allowed — arguably intentional). |
| Implement evidence reference validation | PARTIAL | Presence-only validation (non-empty strings). No URL resolution, timestamp freshness, or cross-referencing against symbol/action. |

### Skipped tasks

None.

---

## Phase 6 — Broker MVP

**Score: 4/9 fully implemented, 5 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement broker-side state revalidation before execution | PARTIAL | `connector.revalidate(intent)` is always called, but `PaperExecutionConnector.revalidate()` trivially returns `passed: true`. EVM/Solana connectors check policy constraints but do not fetch live balance/block state. |
| Implement broker-side idempotency | PARTIAL | `idempotencyKey` is checked and stored, but `BrokerIdempotencyStore` is only an injected interface — no concrete exported implementation, no conflict detection for same-key/different-payload. |
| Implement broker-side audit events | PARTIAL | `broker.revalidated`, `broker.executed`, `broker.failed`, `killswitch.blocked` all emitted. However, `killswitch.activated` (in the audit-event schema) is never written, and audit-write errors are not handled. |
| Implement canary-live execution mode gate | PARTIAL | `broker.ts` gates on `canaryLiveEnabled`, but there is no validation that the injected connector's actual mode matches `BrokerConfig.environment`. A live connector could be wired to a "paper" config. |
| Ensure broker never trusts agent-provided state | PARTIAL | Execution is gated on connector revalidation. Binance live connector fetches market price, but paper revalidation always passes, and EVM/Solana revalidation does not pull live balance/block/slot state. |

### Skipped tasks

None.

---

## Phase 7 — Binance Connector

**Score: 7/17 fully implemented, 8 partial, 2 missing**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement public market data access through broker only | PARTIAL | `getMarketData()` is a method on `BinanceConnector` directly — not channeled exclusively through a broker read API. |
| Implement account snapshot through broker only | PARTIAL | Same — `getAccountSnapshot()` is directly on the connector. |
| Implement spot live order behind `canary_live` | PARTIAL | Broker gates `canaryLiveEnabled`, but the connector itself performs no `canary_live` check. No concrete Binance REST client implementation. |
| Implement USD-M futures live order behind `canary_live` | PARTIAL | Same as spot live order. |
| Implement order status polling | MISSING | No `getOrderStatus` public method on connector. `BinanceApiClient` and `BinancePaperSimulator` both have it defined, but the connector never surfaces or calls them. |
| Enforce USD-M futures isolated-mode and leverage-cap policy | PARTIAL | Leverage cap enforced, but no `marginType`, `ISOLATED`, or isolated-mode field anywhere. Isolated-mode half is unimplemented. |
| Enforce no-withdrawal API key requirement | PARTIAL | Docs cover it. No runtime check validates the API key's withdrawal permission. |
| Add integration tests with mocked Binance API | PARTIAL | `connector.test.ts` has 15 unit tests with a mocked client, but `pnpm test:integration` finds zero `*.integration.test.ts` files. |
| Add optional sandbox/testnet tests | MISSING | No testnet/sandbox test files or env-gated testnet path exist. |

### Skipped tasks

None — but tasks 9 and 17 are genuinely MISSING despite `[x]`.

---

## Phase 8 — Ethereum Sepolia Onchain Connector

**Score: 6/11 fully implemented, 2 partial, 3 missing**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement Ethereum Sepolia RPC provider adapter | MISSING | No concrete `EvmRpcProvider` implementation. No `viem`/`ethers`/`web3` dependency. No `eth_*` RPC calls anywhere in the package. |
| Implement transaction simulation | PARTIAL | `connector.ts` calls `this.provider.simulateTransaction`, but the only `EvmRpcProvider` implementation is the test mock. No real Sepolia simulation adapter. |
| Implement expected balance delta comparison | MISSING | `SimulationResult` has a `balanceChanges` field, but no code compares simulation deltas against expected values. |
| Implement local dev signer for testnet only | PARTIAL | `LocalDevSigner` exists and returns fake tx hashes, but has no chain/environment guard. `EvmConfig.chainEnvironment` can be `"mainnet"` and nothing prevents instantiation. |

### Skipped tasks

None — but tasks 2, 7 (simulation adapter), and 8 are genuinely MISSING despite `[x]`.

---

## Phase 9 — Solana Devnet Onchain Connector

**Score: 5/10 fully implemented, 2 partial, 3 missing**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement Solana devnet RPC provider adapter | MISSING | `SolanaRpcProvider` is interface-only. No concrete class implements it. `@solana/web3.js` is not a declared dependency. |
| Implement simulation before signing | MISSING | `connector.ts` signing path calls `signer.signAndBroadcast` directly without first calling `provider.simulateTransaction`. Simulation only runs on the explicit `onchain.simulate_transaction` action. |
| Implement expected balance delta comparison | MISSING | `balanceChanges` exists in interfaces and test mocks, but no field for expected balance delta and no comparison logic exist. |
| Implement local dev signer for devnet only | PARTIAL | `LocalDevSolanaSigner` exists but has no devnet-only enforcement (no `chainEnvironment` guard). Generates random fake tx hashes rather than real signing. |
| Add tests for all 5 scenarios | PARTIAL | Covers unknown program, known program, authority change, and failed simulation. Missing dedicated connector-level token transfer test. |

### Skipped tasks

None — but tasks 2, 6, and 7 are genuinely MISSING despite `[x]`.

---

## Phase 10 — Secret And Signing Boundary

**Score: 12/17 fully implemented, 5 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Document Vault single-node integrated storage profile | PARTIAL | `docs/deployment-profiles.md` mentions it at summary level only — no concrete Vault config, unseal steps, or backup procedures. |
| Document Vault Kubernetes HA integrated storage profile | PARTIAL | Same — mentions Helm/Raft HA at summary level, no Helm values or operational detail. |
| Document cloud-hosted Vault/HCP profile | PARTIAL | Same — mentioned without setup steps or profile details. |
| Add guardrail that production profiles cannot use Vault dev server | PARTIAL | `packages/secrets/src/env-guard.ts` exports `assertNotVaultDevInProduction` and it is tested, but it is **never called from runtime code** — only re-exported from `index.ts` and used in tests. Also only checks `127.0.0.1:8200`, misses `localhost:8200`. |
| Add secret redaction utility for logs and errors | PARTIAL | `packages/secrets/src/redaction.ts` exists and is tested, but not wired into actual log/error paths. `packages/broker/src/broker.ts:127` writes `data: { error: String(err) }` without redaction. |

### Skipped tasks

None.

---

## Phase 11 — Reviewer Agent Layer

**Score: 10/11 fully implemented, 1 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement `gpt-5.5` reviewer provider adapter | PARTIAL | No concrete `OpenAiLlmProvider` HTTP client exists. `ReviewerAdapter` accepts a generic `LlmProvider` interface (injected). `"gpt-5.5"` appears only as a config string in tests and the `ReviewerConfig` type. Clean design, but no actual OpenAI API integration. |

### Skipped tasks

None.

---

## Phase 12 — Agent Integrations

**Score: 6/11 fully implemented, 3 partial, 2 missing**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Expose only guarded proposal/query tools | PARTIAL | Adapters expose guarded tools, but `onchain.request_signature` and `onchain.get_portfolio` from `packages/schemas/src/intent.ts` are not covered by the adapter surface. |
| Add end-to-end tests (agents propose valid intents) | PARTIAL | `adapters.test.ts` (11 tests) covers valid proposals but uses mocked reviewer/policy/risk — not a true end-to-end stack. No `*.e2e.*` or `*.integration.test.ts` files. |
| Add end-to-end tests (agents cannot access keys/direct paths) | PARTIAL | Same test file checks absence of key/broker/connector properties and rejects unknown direct tools, but no true sandbox/live-execution e2e tests. |
| Add example OpenClaw strategy using guarded tools | MISSING | No example strategy file found anywhere in the repo. |
| Add example Hermes Agent strategy using guarded tools | MISSING | No example strategy file found anywhere in the repo. |

### Skipped tasks

None — but tasks 8 and 9 are genuinely MISSING despite `[x]`.

---

## Phase 13 — Runtime Isolation And Network Controls

**Score: 16/19 fully implemented, 3 partial**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Allowlist LLM providers | PARTIAL | `nginx-egress.conf` only allowlists the guardrail service. No explicit `location` block or upstream for any LLM provider (OpenAI, Anthropic, etc.). May be intentional if agents don't call LLMs directly. |
| Allowlist explicitly approved data sources | PARTIAL | No data source allowlist entries in `nginx-egress.conf`. Only the guardrail upstream is defined. No entries for price feeds, market data APIs, etc. |
| Log DNS and egress attempts | PARTIAL | Nginx HTTP access/error logs write to ephemeral `/tmp` (tmpfs) — no persistence, shipping, or external collector. DNS-level logging is completely absent. |

### Skipped tasks

None.

---

## Phase 14 — Audit Log And Monitoring

**Score: 3/15 fully implemented, 9 partial, 3 missing**

Root cause: **`GuardrailService` has zero audit instrumentation — it never calls `AuditWriter.write()`.** All audit writes in tests are synthetic/isolated.

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Include prompt/session ID in audit events | MISSING | No `promptId`, `sessionId`, or `session_id` column/field anywhere in schema or writer. |
| Include input data references in audit events | MISSING | No structured `inputRef` or raw input pointer written in production code paths. |
| Include human approval details in audit events | MISSING | `GuardrailService` never calls `AuditWriter.write()` — zero audit instrumentation in the service. |
| Include normalized intent JSON in audit events | PARTIAL | The `data` blob could carry it, but the service never writes audit events. |
| Include reviewer verdict in audit events | PARTIAL | Same — value is computed but never audited. |
| Include OPA input and output in audit events | PARTIAL | Same root cause. |
| Include dynamic risk check results in audit events | PARTIAL | Same root cause. |
| Include broker revalidation results in audit events | PARTIAL | Same root cause. |
| Add Drizzle Kit migration for initial audit tables | MISSING | `drizzle.config.ts` references `packages/audit/drizzle` but that directory is empty. Schema created via raw SQL in `writer.ts:initSchema()`, not via Drizzle Kit migration files. |
| Add migration test (SQLite from empty DB) | PARTIAL | Test checks that `AuditWriter` creates the table via its internal raw SQL — not testing a Drizzle Kit migration. |
| Add hash-chain or tamper-evidence design | PARTIAL | `previous_hash` column, SHA-256 chaining, and `getLastHash()` work. However, `recoverLastHash` does not re-derive from actual row content — cannot detect row deletion/alteration. No standalone chain verifier utility. |
| Add tests for audit completeness on allow/deny/needs-human/error flows | PARTIAL | All four flows tested, but assertions only check row counts (`toHaveLength(N)`), not field completeness. |

### Skipped tasks

None — but tasks for prompt/session ID, input data references, human approval details, and Drizzle Kit migration are genuinely MISSING despite `[x]`.

---

## Phase 15 — Human Approval And Kill Switch

**Score: 14/27 fully implemented, 8 partial, 5 missing**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Implement approval audit logging | PARTIAL | `ApprovalRequest` stores timestamps and `decidedBy` inline, but no emission to external `AuditWriter`. `allowlist.updated` event type exists in schema but is never emitted. |
| Implement configurable approval thresholds | PARTIAL | `ApprovalConfig` has only `defaultTimeoutSeconds`. Notional thresholds are in the risk engine, not the approval package. |
| Ensure durable allowlist onboarding creates auditable policy change | MISSING | Approving `allowlist_onboarding` does nothing — no durable record, no `allowlist.updated` audit event, no policy file mutation. Most significant gap in Phase 15. |
| Ensure agent execution creates pending approvals without interactive terminal | PARTIAL | Test only calls `store.create()` and asserts `state === "pending"` — does not prove the end-to-end agent execution path creates approvals non-interactively. |
| Design local web UI approval adapter | PARTIAL | `WebUiAdapterConfig` interface only — no adapter class. Aligns with "design" wording. |
| Design Slack approval adapter | PARTIAL | `SlackAdapterConfig` interface only. |
| Design Telegram approval adapter | PARTIAL | `TelegramAdapterConfig` interface only. |
| Design Discord approval adapter | PARTIAL | `DiscordAdapterConfig` interface only. |
| Design WhatsApp approval adapter | PARTIAL | `WhatsAppAdapterConfig` interface only. |
| Design Signal approval adapter | PARTIAL | `SignalAdapterConfig` interface only. |
| Implement per-account kill switch | PARTIAL | Code exists in `InMemoryKillSwitch` but has zero test coverage. |
| Implement per-chain kill switch | PARTIAL | Code exists but has zero test coverage. |
| Add tests that live execution cannot bypass required approval | PARTIAL | Test only checks that a request has `state === "pending"`. Does not verify that broker rejects execution when approval is missing. |

### Skipped tasks

None — but task 8 (durable allowlist onboarding) is genuinely MISSING despite `[x]`.

---

## Phase 16 — Limited Live Trading Gates

**Score: 3/13 fully implemented, 6 partial, 4 missing**

Note: The commit (`b9ef20f`) that marked Phase 16 complete only changed `planning/init.todo.md` — no Phase-16-specific implementation code was added.

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Set default USD-M futures canary-live notional to USD 5/order and USD 25/day | PARTIAL | Per-order USD 5 is correct. But the daily notional for canary_live is USD 50 (global), not USD 25 as specified. No separate futures-specific daily cap exists. |
| Enforce default USD-M futures max leverage of 1x in canary-live | PARTIAL | `default_max_leverage: 1` is set for auto-approved trades, but `max_leverage` hard cap is 3, meaning 2-3x leveraged trades merely escalate to human rather than being denied. |
| Require Binance no-withdrawal key before live mode | MISSING | Docs only (`docs/live-trading-safety.md`, `docs/key-rotation-runbook.md`). No runtime check validates the API key's withdrawal permission. |
| Require Binance IP allowlist before live mode | MISSING | Docs only. No `ip_allowlist`/`ipAllowlist` field or runtime verifier in any package. |
| Require audit log enabled before live mode | PARTIAL | Broker writes audit events, but no preflight gate verifies audit log health/reachability before starting live mode. |
| Require kill switch enabled before live mode | PARTIAL | Kill switch checked per-execution, but no live-mode readiness gate validates it is configured before the first trade. |
| Require human approval for live mode | PARTIAL | Policy `needs_human` escalation exists. Approval store exists. But the approval store is not wired into `GuardrailService` or broker execution — approvals are not checked at execution time. |
| Add dry-run report before first live trade | MISSING | Referenced in `docs/live-trading-safety.md` only. No implementation. |
| Add post-trade reconciliation after first live trade | MISSING | Documented only. `getOrderStatus` exists as a stub but the broker does not call it for reconciliation. |
| Add rollback procedure for live mode | PARTIAL | Documented runbook in `docs/live-trading-safety.md`. No automated rollback code — intentionally manual, which may be acceptable. |

### Skipped tasks

None — but tasks 6, 7, 11, and 12 are genuinely MISSING despite `[x]`.

---

## Phase 17 — Red Team And Hardening

**Score: 22/29 fully implemented, 5 partial, 2 missing**

### Over-marked `[x]` tasks

| Task | Status | Issue |
|------|--------|-------|
| Test malicious webpage instructions | PARTIAL | Test exists (line 112) but assertion only checks `result.intentId` is truthy — never asserts `outcome === "deny"`. Test passes regardless of detection. |
| Test malicious repository instructions | PARTIAL | Same weak assertion issue (line 119). |
| Test malicious token metadata | PARTIAL | Same weak assertion issue (line 126). |
| Test malicious MCP/tool definitions | MISSING | `mcpToolDefinition` fixture is defined in `fixtures.ts` but no test uses it. |
| Test attempted secret exfiltration through logs | PARTIAL | `secretExfiltrationLog` fixture is defined but unused. No test verifies log output does not contain secrets. |
| Test hallucinated price/balance/position claims | PARTIAL | Only `hallucinatedClaims.fakePrice` is tested. `fakeBalance` and `fakePosition` fixtures exist but are unused. |
| Document findings and fixes | MISSING | No findings/fixes document from Phase 17 red-team runs exists. `docs/threat-model.md` predates Phase 17. |

### Skipped tasks

None — but tasks 5 and 29 are genuinely MISSING despite `[x]`.

---

## Priority Remediation Targets

### P0 — Safety-critical gaps

1. **Wire `AuditWriter` into `GuardrailService`** (Phase 14) — the entire audit pipeline is disconnected from production flows.
2. **Wire human approval store into execution flow** (Phases 15, 16) — approvals exist but are never checked.
3. **Implement simulation before signing in Solana connector** (Phase 9) — core safety feature bypassed in signing path.
4. **Fix Rego↔TypeScript schema mismatch** (Phase 4) — snake_case vs camelCase would cause runtime failures.
5. **Populate daily risk facts into OPA policy input** (Phase 4) — daily notional and loss limit rules are dead code.

### P1 — Functional gaps

6. **Implement concrete EVM RPC provider** (Phase 8) — add `viem` dependency and Sepolia adapter.
7. **Implement concrete Solana RPC provider** (Phase 9) — add `@solana/web3.js` dependency and devnet adapter.
8. **Implement concrete OPA HTTP PolicyEvaluator** (Phase 4) — connect to OPA sidecar.
9. **Implement concrete OpenAI LLM provider** (Phase 11) — wire `gpt-5.5` HTTP client.
10. **Add balance delta comparison** for EVM and Solana (Phases 8, 9).
11. **Call `assertNotVaultDevInProduction` from runtime startup** (Phase 10).
12. **Wire `redactSecrets` into broker error logging** (Phase 10).

### P2 — Completeness gaps

13. **Add Drizzle Kit migration files** (Phase 14) — replace raw SQL schema creation.
14. **Add example strategies** for OpenClaw and Hermes (Phase 12).
15. **Implement live trading preflight gates** — dry-run report, post-trade reconciliation, no-withdrawal key check, IP allowlist check (Phase 16).
16. **Strengthen red-team test assertions** — assert `outcome === "deny"` for prompt injection tests (Phase 17).
17. **Add missing red-team tests** — MCP/tool definitions, log exfiltration, hallucinated balance/position (Phase 17).
18. **Write Phase 17 findings/fixes document** (Phase 17).
19. **Set futures-specific daily notional cap to USD 25** (Phase 16).
20. **Add DNS logging** to egress proxy (Phase 13).
