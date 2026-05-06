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

- [ ] Remove the empty catch block.
- [ ] Decide exact failure semantics.
  - Preferred: keep the kill switch active, then throw a specific audit failure error so callers know audit failed.
  - Safety rationale: kill-switch activation should not be rolled back merely because audit failed.
- [ ] Add an error type or clear error message for audit write failure.
- [ ] Ensure any broker path invoking kill switch can surface or handle this failure safely.
- [ ] If throwing would break intended synchronous interfaces, expose failure through a result object or injected logger instead.

### Regression Tests

- [ ] Audit writer throwing during activation is not swallowed.
- [ ] Kill switch remains active after audit write failure.
- [ ] Successful activation still writes `killswitch.activated` audit event.

### Acceptance Criteria

- [ ] Operators cannot unknowingly trigger unaudited kill-switch changes.
- [ ] Safety state remains conservative if audit fails.

## Phase 7: Vault Provider Response Validation

Finding: malformed successful Vault responses are treated as missing secrets or empty lists.

Relevant files:

- `packages/secrets/src/vault-provider.ts`
- `packages/secrets/src/secrets.test.ts`

### Implementation Checklist

- [ ] Keep 404 behavior unchanged.
  - [ ] `get()` returns `null` on 404.
  - [ ] `list()` returns `[]` on 404.
- [ ] Validate successful `get()` response shape.
  - [ ] Require object body.
  - [ ] Require `data.data.value` to exist.
  - [ ] Require `value` to be a string.
  - [ ] Throw descriptive error on malformed 200 responses.
- [ ] Validate successful `list()` response shape.
  - [ ] Require object body.
  - [ ] Require `data.keys` to exist.
  - [ ] Require every key to be a string.
  - [ ] Throw descriptive error on malformed 200 responses.
- [ ] Ensure thrown errors do not include secret values or Vault token.

### Regression Tests

- [ ] `get()` returns secret string for valid KV v2 response.
- [ ] `get()` returns `null` for 404.
- [ ] `get()` throws for 200 missing `data`.
- [ ] `get()` throws for 200 missing `data.data.value`.
- [ ] `get()` throws for non-string `value`.
- [ ] `list()` returns keys for valid response.
- [ ] `list()` returns `[]` for 404.
- [ ] `list()` throws for missing `data.keys`.
- [ ] `list()` throws for non-string keys.

### Acceptance Criteria

- [ ] Vault mount/API/schema misconfiguration cannot masquerade as empty secrets.
- [ ] Error messages are diagnostic but do not leak sensitive values.

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

- [ ] Define evidence requirements by executed action type.
  - [ ] CEX place order: require `orderId` or `orderStatus`.
  - [ ] CEX cancel: require `orderId` or cancellation-specific status evidence.
  - [ ] CEX order status: require `orderStatus`.
  - [ ] Onchain signing: require `transactionHash`.
  - [ ] Onchain simulation: require simulation evidence, or do not represent it as executed broker-side if no execution occurred.
- [ ] Decide whether to add an `executionKind` discriminator or infer from intent action outside the result schema.
  - Preferred: use an explicit discriminator if result validity depends on action class.
- [ ] Require failed/rejected results to include `rejectionReason`.

### Implementation Checklist

- [ ] Convert `BrokerExecutionResult` to a discriminated union or add strict refinements.
- [ ] Update broker and connector interfaces to require the relevant evidence fields.
- [ ] Update paper connector and tests to return valid evidence.
- [ ] Regenerate JSON schema.

### Regression Tests

- [ ] Executed result with no `orderId`, `orderStatus`, `transactionHash`, or simulation evidence is rejected by schema.
- [ ] Rejected result without `rejectionReason` is rejected by schema.
- [ ] Failed result without `rejectionReason` is rejected by schema.
- [ ] Existing broker happy paths produce schema-valid execution results.

### Acceptance Criteria

- [ ] Every `executed` broker result contains enough durable evidence for audit/reconciliation.
- [ ] Connectors cannot satisfy the interface with empty execution handles.

## Phase 9: Approval Timeout Terminal State

Finding: timeout sets `state = "timeout"` without setting terminal metadata; type permits impossible lifecycle states.

Relevant files:

- `packages/approval/src/interfaces.ts`
- `packages/approval/src/store.ts`
- `packages/approval/src/approval.test.ts`

### Implementation Checklist

- [ ] Update `timeout()` to persist terminal timestamp.
  - [ ] Set `request.decidedAt = decidedAt`.
  - [ ] Keep `request.decidedBy = null` unless a system principal is preferred.
- [ ] Tighten approval state typing.
  - [ ] Consider a discriminated union for `pending`, `approved`, `denied`, `timeout`, and `consumed`.
  - [ ] If a full union causes broad churn, add runtime assertions in store methods as a narrower first step.
- [ ] Ensure `consumed` preserves prior approval metadata or adds `consumedAt` without erasing decision provenance.
- [ ] Ensure audit events and request object agree on terminal timestamps.

### Regression Tests

- [ ] Timed-out request has `state: "timeout"`.
- [ ] Timed-out request has non-null `decidedAt`.
- [ ] Timed-out request has expected `decidedBy` semantics.
- [ ] Approved request cannot have null decision metadata through store APIs.
- [ ] Denied request cannot have null decision metadata through store APIs.
- [ ] Consumed approval preserves enough provenance for audit.

### Acceptance Criteria

- [ ] Approval terminal states are unambiguous in both memory and audit.
- [ ] Timeout audit event and stored request metadata agree.

## Phase 10: Default-Deny Reason Export

Finding: default-deny reason is computed but omitted from exported policy `reasons`.

Relevant files:

- `packages/policy/src/main.rego`
- `packages/policy/src/tests/main_test.rego`
- `packages/guardrail-service/src/service.test.ts`

### Implementation Checklist

- [ ] Update exported `reasons` in `main.rego`.
  - [ ] For `decision == "deny"`, include `all_deny_reasons`.
  - [ ] Preserve hard-deny reasons.
  - [ ] Preserve escalation reasons for `needs_human`.
  - [ ] Avoid duplicating reasons.
- [ ] Ensure matched deny rules remain accurate.
  - [ ] Decide whether `default_deny` should appear in `matched_deny_rules`.
  - [ ] If yes, update `matched_deny_rules`; if no, ensure reasons still include it.

### Regression Tests

- [ ] Default deny returns `default_deny` reason.
- [ ] Hard deny still returns the hard-deny reason.
- [ ] Needs-human still returns escalation reason.
- [ ] Allow still returns allow reason and matched allow rule.

### Acceptance Criteria

- [ ] Operators receive actionable denial reason for normal default-deny cases.
- [ ] Audit records include default-deny context.

## Phase 11: Broker Decision Token and Replay Tests

Finding: token/staleness rejection logic exists but is not covered by tests.

Relevant files:

- `packages/broker/src/broker.ts`
- `packages/broker/src/broker.test.ts`

### Test Checklist

- [ ] Mutated `decisionToken` is rejected with `decision_token_invalid`.
- [ ] Malformed non-hex token is rejected with `decision_token_invalid`.
- [ ] Wrong token length is rejected with `decision_token_invalid`.
- [ ] Token generated for a different intent is rejected.
- [ ] Token generated for a different `correlationId` is rejected.
- [ ] Token generated for a different `outcome` is rejected.
- [ ] Token generated with wrong `approvalId` is rejected for needs-human approvals.
- [ ] Stale `decidedAt` is rejected with `decision_stale`.
- [ ] Future `decidedAt` beyond the allowed skew is rejected with `decision_stale`.
- [ ] Invalid date string is rejected with `decision_stale`.
- [ ] Rejection paths do not call `connector.revalidate`.
- [ ] Rejection paths do not call `connector.execute`.

### Acceptance Criteria

- [ ] Forged, tampered, malformed, stale, or future-dated approvals cannot reach connector revalidation/execution.

## Phase 12: Decision Token Audit Masking Tests

Finding: service masks decision tokens in audit, but tests do not assert this security property.

Relevant files:

- `packages/guardrail-service/src/service.ts`
- `packages/guardrail-service/src/service.test.ts`
- `packages/audit/src/audit.test.ts` if persistence-level checks are added.

### Test Checklist

- [ ] Allow decision returns raw `decisionToken` to caller.
- [ ] `decision.final` audit event does not contain raw token.
- [ ] `decision.final` audit event contains `[sha256:<fingerprint>]` token marker.
- [ ] `JSON.stringify(audit.events)` does not contain raw token.
- [ ] Needs-human decision follows the same masking behavior.
- [ ] Deny decision has no execution decision token.

### Acceptance Criteria

- [ ] Execution credentials are never written raw into audit events.

## Phase 13: Binance Live Revalidation Negative Tests

Finding: live revalidation has important fail-closed checks but only happy-path test coverage.

Relevant files:

- `packages/binance-connector/src/connector.ts`
- `packages/binance-connector/src/connector.test.ts`

### Test Checklist

- [ ] Live revalidation rejects stale market timestamp.
- [ ] Live revalidation rejects future market timestamp.
- [ ] Live revalidation rejects `NaN` timestamp.
- [ ] Live revalidation rejects zero price.
- [ ] Live revalidation rejects negative price.
- [ ] Live revalidation rejects `NaN` price.
- [ ] Live revalidation rejects price deviation above `maxSlippageBps`.
- [ ] Live revalidation rejects executable notional above `maxNotionalUsd`.
- [ ] Live revalidation rejects thrown `getPrice()` as fail-closed.
- [ ] Order-status revalidation still does not fetch market price.

### Acceptance Criteria

- [ ] Broker-side live market checks cannot regress into a pass-through.

## Phase 14: Red-Team Hard-Deny Payload Realism

Finding: several red-team tests named for prohibited payloads use `binanceSpotOrder`, so they do not prove service normalization reaches intended hard-deny rules.

Relevant files:

- `packages/red-team/src/fixtures.ts`
- `packages/red-team/src/red-team.test.ts`
- `packages/schemas/src/fixtures.ts`

### Implementation Checklist

- [ ] Add realistic onchain red-team fixtures.
  - [ ] Ethereum unknown contract signing intent.
  - [ ] Ethereum token approval intent with max uint256 amount.
  - [ ] Ethereum approval calldata without explicit approval metadata.
  - [ ] Solana authority-change signing intent.
  - [ ] Invalid chain/environment pair intent if schema allows constructing malformed payloads for service rejection tests.
- [ ] Replace misleading tests that evaluate `binanceSpotOrder` for onchain cases.
- [ ] For unsupported CEX actions like withdrawal/transfer, explicitly assert whether denial comes from schema rejection or policy hard-deny.

### Regression Tests

- [ ] Unknown Ethereum contract is denied through service path.
- [ ] Unlimited approval is denied through service path by the intended hard-deny reason.
- [ ] Approval calldata without metadata is denied through service path.
- [ ] Solana authority change is denied through service path.
- [ ] Test names match the payload being evaluated.

### Acceptance Criteria

- [ ] Red-team tests exercise realistic bypass attempts, not unrelated deny stubs.

## Phase 15: AuditWriter Persistence-Level Redaction Test

Finding: `AuditWriter` has local redaction before SQLite persistence, but no direct persistence test asserts stored data is redacted.

Relevant files:

- `packages/audit/src/writer.ts`
- `packages/audit/src/audit.test.ts`

### Test Checklist

- [ ] Write an audit event containing nested sensitive fields.
  - [ ] `apiSecret`
  - [ ] `privateKey`
  - [ ] `vaultToken`
  - [ ] `authorization` header
  - [ ] PEM-like private key string
  - [ ] 64-byte hex private key-like value
- [ ] Query SQLite stored `data` JSON directly.
- [ ] Assert raw secret values do not appear in stored JSON.
- [ ] Assert redaction markers do appear where expected.
- [ ] Assert non-sensitive fields are preserved.

### Acceptance Criteria

- [ ] Audit persistence cannot leak common secret shapes even if callers pass them in event data.

## Phase 16: Documentation Corrections

Findings: docs overstate production availability, deployment isolation guarantees, and SQLite append-only guarantees.

Relevant files:

- `README.md`
- `docs/architecture.md`
- `docs/threat-model.md`
- `docs/security-boundaries.md`
- `docs/live-trading-safety.md`

### Documentation Checklist

- [ ] Production profile wording.
  - [ ] Replace present-tense “full production trading” wording with “reserved/planned profile.”
  - [ ] State broker currently rejects production execution.
  - [ ] Keep canary-live wording aligned with broker gates.
- [ ] Security boundary wording.
  - [ ] Clarify that agent network/filesystem restrictions are required deployment controls.
  - [ ] Do not imply current local Docker Compose enforces all sandbox boundaries.
  - [ ] State live use requires runtime/container/orchestrator enforcement.
- [ ] Audit wording.
  - [ ] Replace “SQLite append-only” with “hash-chained SQLite audit records.”
  - [ ] State tamper evidence depends on protecting `AUDIT_HASH_SECRET` and any external hash anchor.
  - [ ] Align listed audit event taxonomy with events actually emitted.
- [ ] Keep docs concise and operationally accurate.

### Acceptance Criteria

- [ ] Operators are not led to believe production execution or sandbox isolation is already fully implemented by provided artifacts.
- [ ] Audit guarantees are described accurately.

## Phase 17: Validation and Final Review

### Package-Level Validation

- [ ] Schemas:
  - [ ] `pnpm --filter @guardrails/schemas build`
  - [ ] `pnpm --filter @guardrails/schemas generate:json-schema`
  - [ ] Relevant schema tests.
- [ ] Guardrail service:
  - [ ] Relevant service tests.
  - [ ] OPA transform tests.
- [ ] Policy:
  - [ ] `opa test packages/policy/src -v`
- [ ] Broker:
  - [ ] Relevant broker tests.
- [ ] Solana connector:
  - [ ] Relevant connector tests.
- [ ] Binance connector:
  - [ ] Relevant connector tests.
- [ ] Secrets:
  - [ ] Relevant Vault provider tests.
- [ ] Approval:
  - [ ] Relevant approval tests.
- [ ] Audit:
  - [ ] Relevant audit tests.
- [ ] Red-team:
  - [ ] Relevant red-team tests.

### Root Validation

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm test:integration` if integration dependencies are available.
- [ ] `pnpm ci` if local environment can support the full quick CI script.

### Review Checklist

- [ ] Re-run a focused security review after fixes.
- [ ] Re-run a focused test coverage review after tests are added.
- [ ] Confirm no raw secrets/tokens are introduced into fixtures, docs, or test snapshots.
- [ ] Confirm generated JSON schemas are formatted and committed if schema changes occur.
- [ ] Confirm no feature flags or compatibility shims were added unnecessarily.
- [ ] Confirm no docs claim stronger guarantees than the implementation provides.

## Done Criteria

- [ ] All three critical findings are fixed and covered by regression tests.
- [ ] All important security/invariant findings are fixed or explicitly deferred with a documented reason.
- [ ] All listed test coverage gaps are covered or explicitly deferred with a documented reason.
- [ ] Documentation accurately reflects production support, deployment requirements, and audit guarantees.
- [ ] Root validation passes, or any unavailable external dependency is clearly documented.
