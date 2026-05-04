# Threat Model and Specification

## Attacker Profiles

### Prompt Injector

An attacker who embeds malicious instructions in external content consumed by the agent: webpages, repository files, social feeds, token metadata, contract descriptions, bridge UIs, or MCP tool responses. The goal is to manipulate the agent into proposing unauthorized trades, revealing secrets, installing tools, changing strategy, or bypassing guardrails.

### Compromised Agent Runtime

The agent process itself is compromised through a vulnerability in its dependencies, a malicious plugin, or a supply-chain attack. The compromised runtime attempts to read environment variables, local files, network services, or other processes to exfiltrate secrets or execute unauthorized actions.

### Compromised Host

The host machine running the agent container is compromised. The attacker has access to the host filesystem, Docker socket, metadata services, SSH agent, cloud credentials, browser profiles, and wallet files. The goal is to escalate from agent-level access to infrastructure-level access.

### Malicious Tool

A tool, plugin, MCP server, or skill definition that has been tampered with or designed to exfiltrate data, modify policy, or submit unauthorized requests. The tool may appear legitimate but contains hidden behavior.

### Malicious RPC/Provider

An RPC provider or data source that returns false chain state, fake balances, manipulated prices, or forged transaction receipts. This includes eclipse attacks where all connected providers are controlled by the attacker, and BGP split attacks that isolate the node from the honest network.

### Leaked Credential User

An external party who has obtained a CEX API key, wallet private key, LLM API key, or other credential through a prior breach, accidental commit, log exposure, or social engineering. The attacker uses the credential directly outside the guardrails framework.

### Unsafe Strategy

An agent strategy that is not malicious but is economically dangerous: it overtrades, ignores slippage, uses excessive leverage, concentrates positions, or acts on hallucinated signals. The strategy may be well-intentioned but poorly calibrated or based on false assumptions.

## Protected Assets

| Asset | Location | Protection Boundary |
|-------|----------|-------------------|
| CEX API keys | Broker / Secret manager (Vault) | Never in agent runtime |
| Wallet private keys | Signer / KMS / HSM / MPC | Never in agent runtime |
| LLM API keys | Proxy / Secret manager | Injected by proxy, not by agent |
| Exchange accounts | Broker-mediated access only | Subaccount isolation, no-withdrawal keys, IP allowlists |
| Signer service | Outside agent sandbox | Policy-gated signing requests only |
| Execution broker | Outside agent sandbox | Accepts only approved guardrail decisions |
| Audit logs | Append-only SQLite with hash-chain | Tamper-evident, not writable by agents |
| Policy bundles | OPA sidecar | Not modifiable by agent runtime |
| Portfolio data | Broker-fetched authoritative state | Agent claims are not trusted |

## Fail-Closed Behavior

The system fails closed — denying the action — in every case where required information is missing, stale, inconsistent, or unavailable.

| Condition | Behavior |
|-----------|----------|
| Missing market data | Deny. Do not execute with stale or absent price data. |
| Stale market data (exceeds freshness threshold) | Deny. Require fresh data within configured seconds. |
| Missing portfolio data | Deny. Do not execute without authoritative balance/position state. |
| Stale portfolio data | Deny. Require fresh portfolio snapshot. |
| Policy engine (OPA) unavailable | Deny. No policy evaluation means no authorization. |
| Policy engine returns error or malformed output | Deny. Treat as no authorization. |
| Reviewer agent unavailable | Deny. Reviewer verdict is required for automatic execution. |
| Reviewer agent returns malformed output | Deny. Treat as no verdict. |
| Signer unavailable | Deny. Cannot execute onchain transactions. |
| Signer returns error or internal failure | Deny. Do not retry without new authorization. |
| Signer returns malformed or unverifiable signature | Deny. Treat as signing failure. |
| Signer refuses signing request (policy rejection) | Deny. Signer-side policy is authoritative. |
| RPC providers disagree beyond tolerance | Deny. Potential eclipse or data integrity issue. |
| Broker internal error | Deny. Do not partially execute. |
| Kill switch enabled | Deny. All execution halted. |
| Audit log writer unavailable | Deny. No unaudited execution allowed. |
| Missing evidence references | Deny. All intents require verifiable evidence. |
| Missing idempotency key | Deny. All execution requests must be idempotent. |

## Supported Actions (MVP)

| Action | Description | Risk Profile |
|--------|-------------|-------------|
| `cex.place_order` | Place a spot or USD-M futures order on Binance | Variable by notional, leverage, symbol |
| `cex.cancel_order` | Cancel an existing order on Binance | Low |
| `cex.get_open_orders` | Query open orders (read-only) | Low |
| `cex.get_portfolio` | Query account balances and positions (read-only) | Low |
| `onchain.simulate_transaction` | Simulate an onchain transaction without signing | Low |
| `onchain.request_signature` | Request signing and broadcast of a simulated transaction | Variable by contract, amount, approval |
| `onchain.get_portfolio` | Query onchain balances and token holdings (read-only) | Low |

## Explicitly Denied Actions (MVP)

These actions are hard-denied and must never be converted into human approval requests.

| Denied Action | Reason |
|---------------|--------|
| CEX withdrawal | Out of scope. No-withdrawal API keys enforced. |
| CEX account transfer | Out of scope. Prevents fund movement between accounts. |
| Spot margin or cross-margin enablement | Out of first scope. Margin modes excluded from MVP. |
| USD-M futures leverage above configured policy cap | Safety boundary. Leverage above cap requires policy change, not runtime override. |
| COIN-M futures trading | Out of first scope. Only USD-M futures supported. |
| Unlimited token approval | Security boundary. Unlimited approvals enable unrestricted token drainage. |
| Unknown contract interaction | Security boundary. Only allowlisted contracts permitted. |
| Bridge transaction without human approval | Safety boundary. Bridge transactions always escalate to `needs_human`; they cannot auto-execute. Attempting a bridge action when no human approval channel is available results in denial. |

## Risk Tiers

| Tier | Description | Examples |
|------|-------------|---------|
| `low` | Small notional, allowlisted asset/contract, well-understood action | Read-only queries; small spot limit orders on allowlisted symbols; cancel orders |
| `medium` | Moderate notional, known but less common asset/contract, or first occurrence | Medium-sized orders; new symbol within allowlisted exchange; onchain transfer to known address |
| `high` | Large notional, futures with leverage, new contract/spender, or unclear simulation | Large orders; leveraged futures; new onchain contract; token approval above threshold |
| `critical` | Potential for significant loss, system-level action, or detected anomaly | Withdrawal attempt; unlimited approval; unknown contract; prompt injection detected; RPC disagreement |

## Human Approval Classes

| Class | Description | When Used |
|-------|-------------|-----------|
| `none` | No human approval required | Low-risk allowlisted actions that pass all automated checks including reviewer approval |
| `required` | Human must approve before execution | Actions outside the automatic execution envelope but not hard-denied |
| `break_glass` | Emergency override requiring elevated human authorization | Reserved for exceptional circumstances; must be separately audited |

## Policy Decision States

| State | Description | Next Step |
|-------|-------------|-----------|
| `allow` | All checks passed; action may execute | Broker executes the action |
| `deny` | Hard-denied by policy; action must not execute | Return structured rejection to agent |
| `needs_human` | Action is potentially valid but requires human review | Create pending approval; wait for human decision |

## Automatic Execution Envelope

An action may auto-execute (without human approval) only when **all** of the following conditions are true:

1. Reviewer verdict is `approve`.
2. The agent principal, action, resource, account mode, symbol, chain, contract, program, token, spender, and destination are all on the applicable allowlists.
3. The action is within configured limits: per-order notional, daily notional, daily loss, slippage, position delta, order frequency, and leverage.
4. Market data, portfolio data, simulation output, and evidence references are fresh and internally consistent.
5. No prompt injection, unsupported claim, suspicious tool behavior, RPC disagreement, or policy/risk-engine uncertainty is detected.
6. Audit log, kill switch, broker, signer, OPA, and all required data providers are healthy.
7. The matching policy rule explicitly sets `requiresHumanApproval: false`.

If any condition is not met, the action either gets `deny` (for hard-deny cases) or `needs_human` (for potentially valid but non-automatic cases).

## `needs_human` Escalation Criteria

The system returns `needs_human` when the request is potentially valid but outside the automatic execution envelope:

- First live trading enablement, canary-live escalation, or production policy change.
- New agent, strategy, account, subaccount, symbol, contract, token, spender, destination, Solana program, or onchain function not yet on a durable allowlist.
- Notional, daily notional, daily loss, slippage, position delta, order frequency, or leverage above the automatic threshold but below the hard-deny threshold.
- Binance USD-M futures leverage above the default cap.
- Large transfer, bridge transaction, governance action, or token approval above configured threshold.
- Reviewer verdict is `needs_human`, or reviewer risk level is high enough to require operator review.
- Evidence and rationale are incomplete or partially mismatched but not clearly malicious.
- Onchain simulation is unclear, balance deltas are surprising, or RPC quorum disagrees within a recoverable tolerance.
- Repeated rejection, cooldown, or loss-control logic asks for operator intervention.

## Hard-Deny Criteria

These cases must be denied outright and must never be converted into human approval requests:

- Agent requests private keys, seed phrases, CEX keys, raw signing access, direct CEX access, or direct RPC/signing paths.
- CEX withdrawal, unauthorized account transfer, spot margin/cross-margin enablement, or out-of-scope COIN-M futures action.
- Unlimited token approval.
- Execution against an unknown contract/program/spender without prior allowlist onboarding.
- Explicit high-confidence prompt injection or malicious tool behavior detected.
- OPA unavailable, kill switch enabled, signer unavailable, missing critical state, stale critical market/portfolio data, or malformed policy input.

## Approval Semantics: One-Time vs. Durable Allowlist

| Type | Description | Persistence |
|------|-------------|------------|
| One-time execution approval | Human approves a specific pending action for immediate execution | Consumed on use; does not affect future requests |
| Durable allowlist onboarding | Human approves adding a new principal/action/resource/condition entry to the policy allowlist | Creates an auditable policy change; affects all future matching requests |

Durable allowlist changes must be recorded as auditable policy changes, not hidden runtime state. The audit log must capture who approved the change, when, and what policy entry was created.

## Audit Event Taxonomy

Every action flowing through the system generates audit events at each decision point:

| Event Type | Description | Required Fields |
|------------|-------------|----------------|
| `intent.received` | Agent submitted a trading intent | intentId, principal, action, resource, environment, requestedAt, idempotencyKey |
| `intent.validated` | Intent passed schema validation | intentId, validationResult |
| `intent.rejected` | Intent failed schema validation | intentId, validationErrors |
| `reviewer.started` | Reviewer agent evaluation began | intentId, reviewerModel, reviewerProvider |
| `reviewer.completed` | Reviewer agent returned verdict | intentId, verdict, riskLevel, reasons, detectedIssues |
| `reviewer.failed` | Reviewer agent failed or returned malformed output | intentId, error |
| `policy.evaluated` | OPA policy evaluation completed | intentId, policyInput, policyOutput, decision |
| `policy.failed` | OPA policy evaluation failed | intentId, error |
| `risk.evaluated` | Dynamic risk checks completed | intentId, riskResults |
| `risk.failed` | Dynamic risk checks failed | intentId, error |
| `approval.created` | Human approval request created | intentId, approvalId, escalationReason |
| `approval.decided` | Human responded to approval request | intentId, approvalId, decision, decidedBy, decidedAt |
| `approval.timeout` | Approval request timed out | intentId, approvalId, timeoutAt |
| `allowlist.updated` | Durable allowlist entry added via approval | approvalId, policyEntry, updatedBy |
| `signer.requested` | Signing request sent to signer service | intentId, signerBackend, transactionHash |
| `signer.completed` | Signer returned a valid signature | intentId, signatureId |
| `signer.failed` | Signer failed, refused, or returned malformed output | intentId, error |
| `broker.revalidated` | Broker performed pre-execution state revalidation | intentId, revalidationResult |
| `broker.executed` | Broker executed the action | intentId, executionResult, orderId or txHash |
| `broker.failed` | Broker execution failed | intentId, error |
| `killswitch.activated` | Kill switch was enabled | scope, activatedBy, activatedAt |
| `killswitch.blocked` | Kill switch blocked an execution | intentId, killswitchScope |

All audit events include: timestamp, correlationId, environment, and a hash linking to the previous event (hash-chain tamper evidence).

## Idempotency Strategy

Every trading and signing request must include an `idempotencyKey` generated by the caller.

- The guardrail service, broker, and connectors must track idempotency keys.
- A repeated request with the same idempotency key and identical payload must return the same result without re-executing.
- A repeated request with the same idempotency key but a different payload must be rejected with a conflict error and audited.
- Idempotency keys must be scoped to principal + action + resource to prevent cross-principal replay.
- Idempotency records must be retained for at least the audit retention period.
- The idempotency window should be configurable per environment (shorter for dev, longer for production).

## Environment Profiles

| Profile | Description | Execution Mode | Human Approval Default |
|---------|-------------|---------------|----------------------|
| `dev` | Local development | No real execution; mock connectors | Human approval not required (reviewer, OPA, fail-closed, audit, and hard-deny rules still apply) |
| `paper` | Paper trading simulation | Simulated execution against live market data | Human approval not required (reviewer, OPA, fail-closed, audit, and hard-deny rules still apply) |
| `testnet` | Blockchain testnet (Sepolia, devnet) | Real testnet transactions with test tokens | Human approval not required (reviewer, OPA, fail-closed, audit, and hard-deny rules still apply) |
| `canary_live` | Limited live trading with tight limits | Real execution with canary notional limits | Required unless explicitly disabled by policy for low-risk allowlisted actions |
| `production` | Full production trading | Real execution with production limits | Required unless explicitly disabled by policy |

Environment profile determines:

- Which connectors are active (mock, paper, testnet, live).
- Default risk limits and notional caps.
- Whether Vault dev server is permitted (dev only).
- Whether human approval is required by default.
- Audit retention and tamper-evidence requirements.
