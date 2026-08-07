# PR Review Summary

Reviewed `master` vs `0877f5664efac5dfc9b2cd7e60cc7dbf894818bc`.

Scope: **178 files**, ~**24k insertions**. I split the review across specialized agents for core guardrails, execution/connectors, errors, tests, type invariants, and comments, then verified the highest-impact findings directly.

## Critical Issues

1. **Unlimited token approval hard-deny is bypassable**  
   `packages/policy/src/rules/deny.rego:35`, `packages/schemas/src/intent.ts:112`, `packages/schemas/src/intent.ts:121`, `packages/guardrail-service/src/service.ts:575`  
   Policy only denies `maxTokenApprovalAmount == "unlimited"`, while the schema accepts any optional string and the service passes it through unchanged. A max-uint approval, omitted amount, or approval encoded only in calldata can avoid the hard-deny.  
   **Fix:** model approval semantics structurally, deny missing/unbounded/max-uint approval amounts, and add Rego/red-team tests for max uint256 and omitted approval amount.

2. **OPA output normalization can fail open for malformed allow responses**  
   `packages/guardrail-service/src/opa-transform.ts:30`-`43`  
   `transformOpaOutput` defaults missing `requires_human_approval` to `false`, missing matched rules to `[]`, and creates `evaluatedAt`. A malformed response like `{ "decision": "allow" }` can validate as an allow decision without allow-rule evidence.  
   **Fix:** require explicit OPA fields and reject `allow` unless matched allow rules/reasons are present.

3. **File-backed broker idempotency can silently forget executed keys**  
   `packages/broker/src/idempotency-store.ts:316`-`319`  
   If the idempotency file is valid JSON but missing/malformed `entries`, `readState()` treats it as `{}`. That can allow duplicate execution after truncation, schema drift, or manual corruption.  
   **Fix:** validate the full file shape and fail closed if persisted idempotency state is malformed.

## Important Issues

1. **Unsupported chain/environment pairs can be allowed**  
   `packages/schemas/src/common.ts:42`, `packages/schemas/src/intent.ts:112`-`137`, `packages/policy/src/policy.json:162`-`170`  
   `chainEnvironment` is flat across Ethereum/Solana, and the wildcard `testnet-all-actions` allow rule can allow nonsensical pairs like `ethereum/devnet` or `solana/sepolia`.  
   **Fix:** encode valid chain/environment pairs in schema or hard-deny invalid pairs in policy.

2. **Solana connector does not independently decode authority-changing raw instructions**  
   `packages/solana-connector/src/parser.ts:3`-`20`, `packages/solana-connector/src/validation.ts:19`-`23`, `packages/solana-connector/src/connector.ts:69`-`73`  
   Authority-change detection relies on caller-supplied instruction `type` strings. The execution boundary should not trust caller-provided parsed labels for binary Solana instructions.  
   **Fix:** decode SPL Token/Token-2022 instruction data or fail closed on opaque raw instructions.

3. **Kill-switch activation audit failures are swallowed**  
   `packages/broker/src/kill-switch.ts:38`-`48`  
   `activate()` changes safety state but ignores audit write failures, leaving no signal that a critical operational event was unaudited.  
   **Fix:** surface the audit failure, or explicitly document/monitor best-effort audit behavior.

4. **Vault provider treats malformed success responses as missing data**  
   `packages/secrets/src/vault-provider.ts:12`-`19`, `packages/secrets/src/vault-provider.ts:42`-`49`  
   A 200 response with missing KV v2 fields becomes `null` or `[]`, hiding Vault mount/version/API misconfiguration.  
   **Fix:** keep 404 as not-found, but validate successful response shape and throw on malformed bodies.

5. **Broker executed results can contain no execution evidence**  
   `packages/schemas/src/broker.ts:18`-`31`  
   `status: "executed"` only requires `revalidationPassed`; `orderId`, `transactionHash`, and `orderStatus` are all optional. This permits unauditable executed results.  
   **Fix:** make broker results a discriminated union by action/status, or require at least one evidence field for executed results.

6. **Approval timeout creates an incomplete terminal state**  
   `packages/approval/src/interfaces.ts:3`-`20`, `packages/approval/src/store.ts:209`-`211`  
   `timeout()` sets `state = "timeout"` but does not set `decidedAt`; the interface also permits impossible terminal combinations.  
   **Fix:** use a discriminated union for approval lifecycle states and persist timeout terminal metadata.

7. **Default-deny reason is computed but not exported**  
   `packages/policy/src/main.rego:50`-`53`, `packages/policy/src/main.rego:74`-`77`  
   `default_deny` is included in `all_deny_reasons`, but exported `reasons` only includes hard-deny and escalation reasons. Normal default denies can return no actionable reason.  
   **Fix:** return `all_deny_reasons` for deny decisions.

## Test Coverage Gaps

1. **Broker decision token and replay rejection are not covered**  
   Relevant code: `packages/broker/src/broker.ts:116`-`126`, `packages/broker/src/broker.ts:547`-`560`  
   Existing tests cover invalid decision outcome at `packages/broker/src/broker.test.ts:506`, but not mutated tokens, stale `decidedAt`, malformed hex, wrong approval IDs, or tampered intents.

2. **Decision-token audit masking is not asserted**  
   `packages/guardrail-service/src/service.ts:213`-`245`  
   The service hashes the token before audit, but tests should assert the raw token never appears in stored/emitted audit data.

3. **Binance live revalidation only has happy-path coverage**  
   `packages/binance-connector/src/connector.ts:109`-`138`, `packages/binance-connector/src/connector.test.ts:243`-`247`  
   Add tests for stale/future timestamps, invalid prices, excessive slippage, and notional exceeding approval.

4. **Red-team hard-deny tests don’t always use real prohibited payloads**  
   `packages/red-team/src/red-team.test.ts:397`-`429`  
   Tests named for unknown contracts/unlimited approvals evaluate `binanceSpotOrder`, so they don’t prove realistic onchain hard-deny payloads survive service normalization and hit the intended policy rule.

5. **AuditWriter persistence-level redaction is untested**  
   `packages/audit/src/writer.ts:227`-`235`  
   Add a SQLite persistence test that writes nested secrets and verifies stored JSON is redacted.

## Documentation / Operator Safety Notes

- Production docs currently imply production trading is available, while broker rejects production execution. See `docs/architecture.md:72` and `docs/threat-model.md:221`.
- Security-boundary docs describe agent network/filesystem isolation as present-tense guarantees, but provided deployment artifacts do not enforce those controls.
- Audit docs overstate “append-only” SQLite guarantees; implementation is hash-chained/tamper-evident only under secret/anchor protection.

## Recommended Action

Fix the three critical issues before merge, then address the unsupported environment pairs and Solana instruction decoding. After that, add the token/replay, audit-token masking, and realistic red-team tests so these security invariants stay locked down.
