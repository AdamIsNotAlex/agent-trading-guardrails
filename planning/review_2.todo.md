# Review 2 Remediation Todo

Source review: `planning/review_2.planning.md`  
Diff reviewed: `master` vs `0877f5664efac5dfc9b2cd7e60cc7dbf894818bc`

## Goals

- Close all security-critical fail-open paths before merge.
- Preserve the project invariant that agents submit structured intents and only deterministic policy/risk/broker layers authorize execution.
- Add regression tests for every security invariant fixed here.
- Keep fixes narrow: do not introduce broad redesigns beyond what each finding requires.

## Priority Order

1. Critical fail-open fixes:
   - Unlimited token approval bypass.
   - Malformed OPA allow output accepted by normalization.
   - File-backed broker idempotency state reset.
2. High-impact execution and policy hardening:
   - Chain/environment pair validation.
   - Solana authority-change detection or fail-closed raw instruction handling.
3. Auditability and invariant fixes:
   - Kill-switch audit failure surfacing.
   - Vault response validation.
   - Broker execution evidence schema.
   - Approval timeout terminal metadata.
   - Default-deny reason export.
4. Regression test gaps.
5. Operator-facing documentation corrections.
6. Full validation pass.

## Phase 0: Baseline and Scope Checks

- [x] Confirm the working tree is clean or intentionally contains only review planning files.
  - Command: `git status --short --branch`
  - Baseline: clean on `master...origin/master` before implementation.
- [x] Re-read `planning/review_2.planning.md` before starting implementation.
- [x] Identify current package-level test commands for each touched package.
  - Root validation commands are listed in `CLAUDE.md`.
  - Guardrail service focused tests: `pnpm vitest run packages/guardrail-service/src/opa-transform.test.ts packages/guardrail-service/src/service.test.ts`.
- [x] Record baseline validation status before changes.
  - [x] `pnpm typecheck` — passed.
  - [x] `pnpm test` — failed before changes in `packages/red-team/src/red-team.test.ts` (`signer unavailable → broker rejects`, `global kill switch blocks broker execution`).
  - [x] `opa test packages/policy/src -v` if local OPA is installed — OPA installed and 51/51 tests passed.
- [x] If schema shapes change, plan to regenerate JSON schema files.
  - Command: `pnpm --filter @guardrails/schemas generate:json-schema`

## Phase 1: Critical Issue 1 — Unlimited Token Approval Bypass

Finding: policy only denies `maxTokenApprovalAmount == "unlimited"`, while intent schema accepts any optional string and service passes it through unchanged.

Relevant files:

- `packages/schemas/src/intent.ts`
- `packages/schemas/src/policy.ts`
- `packages/schemas/src/fixtures.ts`
- `packages/schemas/src/schemas.test.ts`
- `packages/schemas/json-schema/*.json`
- `packages/guardrail-service/src/service.ts`
- `packages/guardrail-service/src/opa-transform.test.ts`
- `packages/policy/src/rules/deny.rego`
- `packages/policy/src/policy.json`
- `packages/policy/src/tests/main_test.rego`
- `packages/red-team/src/red-team.test.ts`

### Design Checklist

- [x] Decide the minimal structured representation needed for token approval facts.
  - Preferred direction: compute explicit policy facts before OPA instead of asking Rego to parse huge integers.
  - Candidate facts:
    - `isTokenApproval: boolean`
    - `tokenApprovalAmount: string | null`
    - `tokenApprovalAmountMissing: boolean`
    - `tokenApprovalUnlimited: boolean`
    - `tokenApprovalAmountExceedsCap: boolean`
- [x] Define the exact detection scope.
  - [x] Ethereum ERC-20 `approve(address,uint256)` selector: `0x095ea7b3`.
  - [x] Any existing explicit `maxTokenApprovalAmount` field.
  - [x] Omitted approval amount when calldata indicates an approval.
- [x] Define safe amount parsing rules.
  - [x] Treat non-decimal strings as invalid for approval amounts unless they are explicitly denied sentinel values.
  - [x] Use `BigInt` in TypeScript for large approval amounts; do not use `number` for uint256-sized values.
  - [x] Deny max uint256 exactly: `115792089237316195423570985008687907853269984665640564039457584007913129639935`.
  - [x] Deny common unbounded aliases: `unlimited`, `max`, `uint256.max`, `MaxUint256`, case-insensitive if accepted as input.
- [x] Decide where the per-token/per-environment approval cap lives.
  - Preferred direction: add a policy data limit and pass a precomputed boolean to OPA.
  - Avoid adding exchange-specific or chain-specific abstractions unless needed for the finding.

### Implementation Checklist

- [x] Update the schema layer to make approval metadata explicit and validated.
  - [x] Restrict `maxTokenApprovalAmount` to a finite decimal string if retained.
  - [x] Add schema tests for valid finite amount, invalid non-decimal amount, max uint256, and missing approval amount for approval calldata.
  - [x] Update fixtures to use valid approval metadata where required.
- [x] Update guardrail-service policy input normalization.
  - [x] Detect ERC-20 approval calldata from `intent.data` for Ethereum signing intents.
  - [x] Extract the `uint256` amount from calldata when possible.
  - [x] Derive policy facts for missing, unlimited, and cap-exceeding approval amounts.
  - [x] Ensure malformed approval calldata fails closed before policy allow can occur.
- [x] Update `PolicyInput` schema to include the new approval facts.
  - [x] Keep new fields optional only if absence is impossible for non-approval actions.
  - [x] Avoid allowing `undefined` to mean safe for approval-like calldata.
- [x] Update Rego hard-deny rules.
  - [x] Deny explicit unlimited/max approval facts.
  - [x] Deny missing approval amount when `isTokenApproval` is true.
  - [x] Deny approval amount above configured cap.
  - [x] Preserve existing hard-deny precedence over escalation and allow rules.
- [x] Update policy data if a cap is introduced.
  - [x] Add conservative testnet/canary limits.
  - [x] Do not loosen existing allowlists.
- [x] Regenerate JSON schemas after schema changes.

### Regression Tests

- [x] Add Rego tests:
  - [x] Literal `unlimited` is denied.
  - [x] Max uint256 is denied.
  - [x] Approval calldata with omitted approval amount is denied.
  - [x] Approval amount above cap is denied.
  - [x] Finite approval amount within cap is not hard-denied solely by approval rule.
- [x] Add guardrail-service tests:
  - [x] ERC-20 approval calldata is classified as token approval.
  - [x] Max uint256 approval reaches policy as a deny fact.
  - [x] Missing approval amount for approval calldata cannot become `allow`.
- [x] Add red-team tests with realistic onchain signing payloads:
  - [x] Unknown contract approval is denied by unknown-contract rule.
  - [x] Allowlisted contract with max approval is denied by unlimited approval rule.
  - [x] Approval encoded in calldata without explicit amount metadata is denied.

### Acceptance Criteria

- [x] No onchain signing request can become `allow` when it requests an unlimited or unbounded token approval.
- [x] Policy tests prove the hard-deny rule, not only schema rejection.
- [x] Red-team tests use realistic onchain payloads instead of `binanceSpotOrder` stubs.

## Phase 2: Critical Issue 2 — OPA Output Normalization Fail-Open

Finding: `transformOpaOutput` can turn malformed OPA output like `{ "decision": "allow" }` into a valid allow decision.

Relevant files:

- `packages/guardrail-service/src/opa-transform.ts`
- `packages/guardrail-service/src/opa-transform.test.ts`
- `packages/guardrail-service/src/service.test.ts`
- `packages/schemas/src/policy.ts`
- `packages/policy/src/main.rego`

### Implementation Checklist

- [x] Replace permissive defaults in `transformOpaOutput` with strict validation.
  - [x] Require explicit `decision`.
  - [x] Require explicit `requires_human_approval` or `requiresHumanApproval`.
  - [x] Require explicit matched allow and deny rule arrays.
  - [x] Require explicit reasons array or explicitly mapped OPA reason arrays.
  - [x] Require `evaluatedAt` from OPA or deliberately set it only after validating the rest of the output.
- [x] Add allow-specific validation.
  - [x] If `decision === "allow"`, require at least one matched allow rule or allow reason.
  - [x] If `decision === "allow"`, require `requiresHumanApproval === false`.
- [x] Add deny/needs-human consistency validation.
  - [x] If `decision === "deny"`, require at least one deny/default-deny reason.
  - [x] If `decision === "needs_human"`, require `requiresHumanApproval === true`.
- [x] Ensure thrown transform errors remain fail-closed in `GuardrailService.evaluate`.
  - Expected result: service returns deny with `policy_evaluation_failed`.
  - No decision token should be created for this deny.

### Regression Tests

- [x] `transformOpaOutput({ decision: "allow" })` throws.
- [x] Missing `requires_human_approval` throws.
- [x] Missing matched rule arrays throws.
- [x] `allow` with empty matched allow rules throws.
- [x] `needs_human` with `requires_human_approval: false` throws.
- [x] Service test verifies malformed policy output produces deny/fail-closed behavior.
- [x] Service test verifies no decision token is issued for malformed OPA output.

### Acceptance Criteria

- [x] No malformed or partial OPA response can normalize into `allow`.
- [x] OPA response-shape regressions become fail-closed denials.

## Phase 3: Critical Issue 3 — File-Backed Broker Idempotency State Reset

Finding: file-backed idempotency treats valid JSON without `entries` as an empty store, allowing duplicate execution.

Relevant files:

- `packages/broker/src/idempotency-store.ts`
- `packages/broker/src/broker.test.ts`
- `packages/broker/src/idempotency-store.test.ts` if created or existing.
- `packages/schemas/src/broker.ts`

### Implementation Checklist

- [x] Add strict runtime validation for persisted file state.
  - [x] File root must be an object.
  - [x] `entries` must exist and be a plain object.
  - [x] Every entry key must map to a valid idempotency record.
  - [x] Entry status must be one of the known statuses.
  - [x] Entry payload hash must be present and valid.
  - [x] Completed entries must contain a valid result payload.
  - [x] In-progress entries must contain required in-progress metadata.
- [x] Make malformed state fail closed.
  - [x] Do not return `{ entries: {} }` for malformed state.
  - [x] Throw a clear error that blocks execution before connector calls.
- [x] Preserve behavior for a missing file.
  - [x] Missing file can still initialize as `{ entries: {} }`.
- [x] Decide whether to quarantine malformed files.
  - Preferred for this remediation: do not mutate or auto-repair malformed state unless explicitly requested by an operator.
- [x] Ensure lock handling still releases locks when validation throws.

### Regression Tests

- [x] Missing idempotency file initializes empty.
- [x] Valid idempotency file loads existing completed entry.
- [x] Valid JSON missing `entries` throws.
- [x] `entries: null` throws.
- [x] Malformed entry throws.
- [x] Broker execution with malformed idempotency state does not call `connector.revalidate`.
- [x] Broker execution with malformed idempotency state does not call `connector.execute`.

### Acceptance Criteria

- [x] Corrupt or schema-drifted idempotency state cannot silently permit duplicate execution.
- [x] Missing state remains supported for first startup.

## Phase 4: Unsupported Chain/Environment Pair Validation

Finding: schemas permit nonsensical chain/environment pairs, and wildcard testnet policy can allow them.

Relevant files:

- `packages/schemas/src/common.ts`
- `packages/schemas/src/intent.ts`
- `packages/schemas/src/fixtures.ts`
- `packages/schemas/src/schemas.test.ts`
- `packages/policy/src/rules/deny.rego`
- `packages/policy/src/tests/main_test.rego`
- `packages/guardrail-service/src/service.test.ts`
- `packages/evm-connector/src/interfaces.ts`
- `packages/solana-connector/src/interfaces.ts`

### Implementation Checklist

- [x] Encode valid pairs at the schema boundary.
  - [x] Ethereum intents allow only `sepolia` and `mainnet` if mainnet is represented for hard-deny paths.
  - [x] Solana intents allow only `devnet` and `mainnet` if mainnet is represented for hard-deny paths.
  - [x] First-scope signing should still deny mainnet execution per policy/broker invariants.
- [x] Add policy defense-in-depth.
  - [x] Hard-deny `ethereum/devnet`.
  - [x] Hard-deny `solana/sepolia`.
  - [x] Hard-deny unsupported onchain `mainnet` signing unless explicitly supported in future work.
- [x] Update fixtures and generated JSON schemas.
- [x] Ensure service canonical resource generation cannot produce allowable resources for invalid pairs.

### Regression Tests

- [x] Schema rejects Ethereum `devnet` signing and simulation intents.
- [x] Schema rejects Solana `sepolia` signing and simulation intents.
- [x] Policy denies invalid pair if malformed input reaches OPA.
- [x] Red-team test covers invalid chain/environment pair through service path.

### Acceptance Criteria

- [x] Invalid chain/environment pairs fail closed before broker execution.
- [x] Wildcard testnet allowlist cannot allow unsupported onchain combinations.

## Phase 5: Solana Authority-Change Detection

Finding: connector authority-change detection trusts caller-supplied instruction `type`; raw binary Solana instructions can hide authority changes.

Relevant files:

- `packages/solana-connector/src/parser.ts`
- `packages/solana-connector/src/validation.ts`
- `packages/solana-connector/src/connector.ts`
- `packages/solana-connector/src/connector.test.ts`
- `packages/solana-connector/src/interfaces.ts`
- `packages/guardrail-service/src/service.ts`
- `packages/policy/src/rules/deny.rego`
- `packages/policy/src/tests/main_test.rego`

### Design Checklist

- [x] Choose the narrowest safe implementation:
  - Option A: decode SPL Token and Token-2022 instruction data for allowlisted token programs and reject `SetAuthority` variants.
  - Option B: fail closed for opaque raw instruction data until decoding is implemented.
- [x] Prefer fail-closed behavior if decoding coverage is incomplete.
- [x] Do not trust caller-provided `type` for raw instruction bytes.
- [x] Decide whether parsed instruction `type` can still be accepted for non-raw fixtures/tests.
  - If retained, only use it when no raw `data` field exists and it comes from trusted internal parsing.

### Implementation Checklist

- [x] Update parser to distinguish trusted parsed instructions from opaque raw instructions.
- [x] For raw instructions:
  - [x] Decode known token-program instruction variants, or
  - [x] Return a validation failure such as `Solana raw instruction data is unsupported without trusted decoding.`
- [x] Update `validateAuthorityChange` so `SetAuthority` cannot pass when encoded in raw instruction data.
- [x] Update guardrail-service instruction-type extraction if needed so policy and connector agree.
- [x] Keep OPA hard-deny for `setAuthority` as defense-in-depth.

### Regression Tests

- [x] Raw SPL Token `SetAuthority` instruction is rejected even when program/account allowlists pass.
- [x] Raw Token-2022 `SetAuthority` instruction is rejected if Token-2022 is in scope.
- [x] Opaque raw instruction data is rejected if decoding is not implemented.
- [x] Safe transfer instruction remains accepted when fully decoded/trusted.
- [x] Service/policy path still denies `setAuthority` when instruction type is known.

### Acceptance Criteria

- [x] Authority-changing Solana instructions cannot be smuggled through raw instruction data.
- [x] Balance-delta checks are not the only protection against authority changes.

## Phase 6: Kill-Switch Audit Failure Surfacing

Finding: `InMemoryKillSwitch.activate()` catches and ignores audit write failures.

Relevant files:

- `packages/broker/src/kill-switch.ts`
- `packages/broker/src/broker.test.ts`
- `packages/broker/src/interfaces.ts`

### Implementation Checklist

- [x] Remove the empty catch block.
- [x] Decide exact failure semantics.
  - Preferred: keep the kill switch active, then throw a specific audit failure error so callers know audit failed.
  - Safety rationale: kill-switch activation should not be rolled back merely because audit failed.
- [x] Add an error type or clear error message for audit write failure.
- [x] Ensure any broker path invoking kill switch can surface or handle this failure safely.
- [x] If throwing would break intended synchronous interfaces, expose failure through a result object or injected logger instead.

### Regression Tests

- [x] Audit writer throwing during activation is not swallowed.
- [x] Kill switch remains active after audit write failure.
- [x] Successful activation still writes `killswitch.activated` audit event.

### Acceptance Criteria

- [x] Operators cannot unknowingly trigger unaudited kill-switch changes.
- [x] Safety state remains conservative if audit fails.

## Phase 7: Vault Provider Response Validation

Finding: malformed successful Vault responses are treated as missing secrets or empty lists.

Relevant files:

- `packages/secrets/src/vault-provider.ts`
- `packages/secrets/src/secrets.test.ts`

### Implementation Checklist

- [x] Keep 404 behavior unchanged.
  - [x] `get()` returns `null` on 404.
  - [x] `list()` returns `[]` on 404.
- [x] Validate successful `get()` response shape.
  - [x] Require object body.
  - [x] Require `data.data.value` to exist.
  - [x] Require `value` to be a string.
  - [x] Throw descriptive error on malformed 200 responses.
- [x] Validate successful `list()` response shape.
  - [x] Require object body.
  - [x] Require `data.keys` to exist.
  - [x] Require every key to be a string.
  - [x] Throw descriptive error on malformed 200 responses.
- [x] Ensure thrown errors do not include secret values or Vault token.

### Regression Tests

- [x] `get()` returns secret string for valid KV v2 response.
- [x] `get()` returns `null` for 404.
- [x] `get()` throws for 200 missing `data`.
- [x] `get()` throws for 200 missing `data.data.value`.
- [x] `get()` throws for non-string `value`.
- [x] `list()` returns keys for valid response.
- [x] `list()` returns `[]` for 404.
- [x] `list()` throws for missing `data.keys`.
- [x] `list()` throws for non-string keys.

### Acceptance Criteria

- [x] Vault mount/API/schema misconfiguration cannot masquerade as empty secrets.
- [x] Error messages are diagnostic but do not leak sensitive values.

## Phase 8: Broker Execution Evidence Schema

Finding: `BrokerExecutionResult` permits `status: "executed"` with no execution evidence.

Relevant files:

- `packages/schemas/src/broker.ts`
- `packages/schemas/src/schemas.test.ts`
- `packages/schemas/json-schema/broker-execution-result.json`
- `packages/broker/src/interfaces.ts`
- `packages/broker/src/broker.ts`
- `packages/broker/src/broker.test.ts`
- Connector implementations returning execution results.

### Design Checklist

- [x] Define evidence requirements by executed action type.
  - [x] CEX place order: require `orderId` or `orderStatus`.
  - [x] CEX cancel: require `orderId` or cancellation-specific status evidence.
  - [x] CEX order status: require `orderStatus`.
  - [x] Onchain signing: require `transactionHash`.
  - [x] Onchain simulation: require simulation evidence, or do not represent it as executed broker-side if no execution occurred.
- [x] Decide whether to add an `executionKind` discriminator or infer from intent action outside the result schema.
  - Preferred: use an explicit discriminator if result validity depends on action class.
- [x] Require failed/rejected results to include `rejectionReason`.

### Implementation Checklist

- [x] Convert `BrokerExecutionResult` to a discriminated union or add strict refinements.
- [x] Update broker and connector interfaces to require the relevant evidence fields.
- [x] Update paper connector and tests to return valid evidence.
- [x] Regenerate JSON schema.

### Regression Tests

- [x] Executed result with no `orderId`, `orderStatus`, `transactionHash`, or simulation evidence is rejected by schema.
- [x] Rejected result without `rejectionReason` is rejected by schema.
- [x] Failed result without `rejectionReason` is rejected by schema.
- [x] Existing broker happy paths produce schema-valid execution results.

### Acceptance Criteria

- [x] Every `executed` broker result contains enough durable evidence for audit/reconciliation.
- [x] Connectors cannot satisfy the interface with empty execution handles.

## Phase 9: Approval Timeout Terminal State

Finding: timeout sets `state = "timeout"` without setting terminal metadata; type permits impossible lifecycle states.

Relevant files:

- `packages/approval/src/interfaces.ts`
- `packages/approval/src/store.ts`
- `packages/approval/src/approval.test.ts`

### Implementation Checklist

- [x] Update `timeout()` to persist terminal timestamp.
  - [x] Set `request.decidedAt = decidedAt`.
  - [x] Keep `request.decidedBy = null` unless a system principal is preferred.
- [x] Tighten approval state typing.
  - [x] Consider a discriminated union for `pending`, `approved`, `denied`, `timeout`, and `consumed`.
  - [x] Full discriminated union landed without broad churn, so narrower runtime assertions were not needed.
- [x] Ensure `consumed` preserves prior approval metadata or adds `consumedAt` without erasing decision provenance.
- [x] Ensure audit events and request object agree on terminal timestamps.

### Regression Tests

- [x] Timed-out request has `state: "timeout"`.
- [x] Timed-out request has non-null `decidedAt`.
- [x] Timed-out request has expected `decidedBy` semantics.
- [x] Approved request cannot have null decision metadata through store APIs.
- [x] Denied request cannot have null decision metadata through store APIs.
- [x] Consumed approval preserves enough provenance for audit.

### Acceptance Criteria

- [x] Approval terminal states are unambiguous in both memory and audit.
- [x] Timeout audit event and stored request metadata agree.

## Phase 10: Default-Deny Reason Export

Finding: default-deny reason is computed but omitted from exported policy `reasons`.

Relevant files:

- `packages/policy/src/main.rego`
- `packages/policy/src/tests/main_test.rego`
- `packages/guardrail-service/src/service.test.ts`

### Implementation Checklist

- [x] Update exported `reasons` in `main.rego`.
  - [x] For `decision == "deny"`, include `all_deny_reasons`.
  - [x] Preserve hard-deny reasons.
  - [x] Preserve escalation reasons for `needs_human`.
  - [x] Avoid duplicating reasons.
- [x] Ensure matched deny rules remain accurate.
  - [x] Decide whether `default_deny` should appear in `matched_deny_rules`.
  - [x] If yes, update `matched_deny_rules`; if no, ensure reasons still include it.

### Regression Tests

- [x] Default deny returns `default_deny` reason.
- [x] Hard deny still returns the hard-deny reason.
- [x] Needs-human still returns escalation reason.
- [x] Allow still returns allow reason and matched allow rule.

### Acceptance Criteria

- [x] Operators receive actionable denial reason for normal default-deny cases.
- [x] Audit records include default-deny context.

## Phase 11: Broker Decision Token and Replay Tests

Finding: token/staleness rejection logic exists but is not covered by tests.

Relevant files:

- `packages/broker/src/broker.ts`
- `packages/broker/src/broker.test.ts`

### Test Checklist

- [x] Mutated `decisionToken` is rejected with `decision_token_invalid`.
- [x] Malformed non-hex token is rejected with `decision_token_invalid`.
- [x] Wrong token length is rejected with `decision_token_invalid`.
- [x] Token generated for a different intent is rejected.
- [x] Token generated for a different `correlationId` is rejected.
- [x] Token generated for a different `outcome` is rejected.
- [x] Token generated with wrong `approvalId` is rejected for needs-human approvals.
- [x] Stale `decidedAt` is rejected with `decision_stale`.
- [x] Future `decidedAt` beyond the allowed skew is rejected with `decision_stale`.
- [x] Invalid date string is rejected with `decision_stale`.
- [x] Rejection paths do not call `connector.revalidate`.
- [x] Rejection paths do not call `connector.execute`.

### Acceptance Criteria

- [x] Forged, tampered, malformed, stale, or future-dated approvals cannot reach connector revalidation/execution.

## Phase 12: Decision Token Audit Masking Tests

Finding: service masks decision tokens in audit, but tests do not assert this security property.

Relevant files:

- `packages/guardrail-service/src/service.ts`
- `packages/guardrail-service/src/service.test.ts`
- `packages/audit/src/audit.test.ts` if persistence-level checks are added.

### Test Checklist

- [x] Allow decision returns raw `decisionToken` to caller.
- [x] `decision.final` audit event does not contain raw token.
- [x] `decision.final` audit event contains `[sha256:<fingerprint>]` token marker.
- [x] `JSON.stringify(audit.events)` does not contain raw token.
- [x] Needs-human decision follows the same masking behavior.
- [x] Deny decision has no execution decision token.

### Acceptance Criteria

- [x] Execution credentials are never written raw into audit events.

## Phase 13: Binance Live Revalidation Negative Tests

Finding: live revalidation has important fail-closed checks but only happy-path test coverage.

Relevant files:

- `packages/binance-connector/src/connector.ts`
- `packages/binance-connector/src/connector.test.ts`

### Test Checklist

- [x] Live revalidation rejects stale market timestamp.
- [x] Live revalidation rejects future market timestamp.
- [x] Live revalidation rejects `NaN` timestamp.
- [x] Live revalidation rejects zero price.
- [x] Live revalidation rejects negative price.
- [x] Live revalidation rejects `NaN` price.
- [x] Live revalidation rejects price deviation above `maxSlippageBps`.
- [x] Live revalidation rejects executable notional above `maxNotionalUsd`.
- [x] Live revalidation rejects thrown `getPrice()` as fail-closed.
- [x] Order-status revalidation still does not fetch market price.

### Acceptance Criteria

- [x] Broker-side live market checks cannot regress into a pass-through.

## Phase 14: Red-Team Hard-Deny Payload Realism

Finding: several red-team tests named for prohibited payloads use `binanceSpotOrder`, so they do not prove service normalization reaches intended hard-deny rules.

Relevant files:

- `packages/red-team/src/fixtures.ts`
- `packages/red-team/src/red-team.test.ts`
- `packages/schemas/src/fixtures.ts`

### Implementation Checklist

- [x] Add realistic onchain red-team fixtures.
  - [x] Ethereum unknown contract signing intent.
  - [x] Ethereum token approval intent with max uint256 amount.
  - [x] Ethereum approval calldata without explicit approval metadata.
  - [x] Solana authority-change signing intent.
  - [x] Invalid chain/environment pair intent if schema allows constructing malformed payloads for service rejection tests.
- [x] Replace misleading tests that evaluate `binanceSpotOrder` for onchain cases.
- [x] For unsupported CEX actions like withdrawal/transfer, explicitly assert whether denial comes from schema rejection or policy hard-deny.

### Regression Tests

- [x] Unknown Ethereum contract is denied through service path.
- [x] Unlimited approval is denied through service path by the intended hard-deny reason.
- [x] Approval calldata without metadata is denied through service path.
- [x] Solana authority change is denied through service path.
- [x] Test names match the payload being evaluated.

### Acceptance Criteria

- [x] Red-team tests exercise realistic bypass attempts, not unrelated deny stubs.

## Phase 15: AuditWriter Persistence-Level Redaction Test

Finding: `AuditWriter` has local redaction before SQLite persistence, but no direct persistence test asserts stored data is redacted.

Relevant files:

- `packages/audit/src/writer.ts`
- `packages/audit/src/audit.test.ts`

### Test Checklist

- [x] Write an audit event containing nested sensitive fields.
  - [x] `apiSecret`
  - [x] `privateKey`
  - [x] `vaultToken`
  - [x] `authorization` header
  - [x] PEM-like private key string
  - [x] 64-byte hex private key-like value
- [x] Query SQLite stored `data` JSON directly.
- [x] Assert raw secret values do not appear in stored JSON.
- [x] Assert redaction markers do appear where expected.
- [x] Assert non-sensitive fields are preserved.

### Acceptance Criteria

- [x] Audit persistence cannot leak common secret shapes even if callers pass them in event data.

## Phase 16: Documentation Corrections

Findings: docs overstate production availability, deployment isolation guarantees, and SQLite append-only guarantees.

Relevant files:

- `README.md`
- `docs/architecture.md`
- `docs/threat-model.md`
- `docs/security-boundaries.md`
- `docs/live-trading-safety.md`

### Documentation Checklist

- [x] Production profile wording.
  - [x] Replace present-tense “full production trading” wording with “reserved/planned profile.”
  - [x] State broker currently rejects production execution.
  - [x] Keep canary-live wording aligned with broker gates.
- [x] Security boundary wording.
  - [x] Clarify that agent network/filesystem restrictions are required deployment controls.
  - [x] Do not imply current local Docker Compose enforces all sandbox boundaries.
  - [x] State live use requires runtime/container/orchestrator enforcement.
- [x] Audit wording.
  - [x] Replace “SQLite append-only” with “hash-chained SQLite audit records.”
  - [x] State tamper evidence depends on protecting `AUDIT_HASH_SECRET` and any external hash anchor.
  - [x] Align listed audit event taxonomy with events actually emitted.
- [x] Keep docs concise and operationally accurate.

### Acceptance Criteria

- [x] Operators are not led to believe production execution or sandbox isolation is already fully implemented by provided artifacts.
- [x] Audit guarantees are described accurately.

## Phase 17: Validation and Final Review

### Package-Level Validation

- [x] Schemas:
  - [x] `pnpm --filter @guardrails/schemas build`
  - [x] `pnpm --filter @guardrails/schemas generate:json-schema`
  - [x] Relevant schema tests.
- [x] Guardrail service:
  - [x] Relevant service tests.
  - [x] OPA transform tests.
- [x] Policy:
  - [x] `opa test packages/policy/src -v`
- [x] Broker:
  - [x] Relevant broker tests.
- [x] Solana connector:
  - [x] Relevant connector tests.
- [x] Binance connector:
  - [x] Relevant connector tests.
- [x] Secrets:
  - [x] Relevant Vault provider tests.
- [x] Approval:
  - [x] Relevant approval tests.
- [x] Audit:
  - [x] Relevant audit tests.
- [x] Red-team:
  - [x] Relevant red-team tests.

### Root Validation

- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm build`
- [x] `pnpm test`
- [x] `pnpm test:integration` if integration dependencies are available.
- [x] `pnpm run ci` completed successfully; bare `pnpm ci` is not implemented by pnpm 10.33.2.

### Review Checklist

- [x] Re-run a focused security review after fixes.
- [x] Re-run a focused test coverage review after tests are added.
- [x] Confirm no raw secrets/tokens are introduced into fixtures, docs, or test snapshots.
- [x] Confirm generated JSON schemas are formatted and committed if schema changes occur.
- [x] Confirm no feature flags or compatibility shims were added unnecessarily.
- [x] Confirm no docs claim stronger guarantees than the implementation provides.

## Done Criteria

- [x] All three critical findings are fixed and covered by regression tests.
- [x] All important security/invariant findings are fixed or explicitly deferred with a documented reason.
- [x] All listed test coverage gaps are covered or explicitly deferred with a documented reason.
- [x] Documentation accurately reflects production support, deployment requirements, and audit guarantees.
- [x] Root validation passes, or any unavailable external dependency is clearly documented.
