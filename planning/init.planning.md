# Agent Trading Guardrails Framework - Initial Planning

Date: 2026-05-04

## Problem

Build a guardrails framework for trading agents. The framework should support at least OpenClaw and Hermes Agent, and allow agents to propose or execute trades on centralized exchanges (CEX) and onchain protocols without giving the agent unrestricted access to credentials, wallets, RPC endpoints, or exchange APIs.

Primary security goals:

- Prevent model hallucination from becoming real trading activity.
- Reduce prompt injection risk from webpages, repositories, social feeds, contract metadata, or other untrusted inputs.
- Limit blast radius if the agent runtime or host machine is compromised.
- Prevent leakage of LLM API keys, CEX API keys, wallet private keys, and signing secrets.
- Preserve clear auditability for every proposed and executed action.

Initial design hypothesis:

- Use two cognitive layers: one agent thinks and proposes actions; another agent reviews the proposal.
- Do not rely on the reviewer agent as the final security boundary.
- Final allow/deny must be enforced by deterministic policy, broker, signer, sandbox, network controls, and secret isolation.

Future work:

- Defend connected RPC nodes against eclipse attacks and BGP split attacks.

## Current Repository State

The repository is currently empty except for `.git`. The `master` branch has no commits yet. There are no existing code, framework, dependency, or architecture constraints, so this plan assumes a greenfield implementation.

## Key Architectural Judgment

The two-agent design is useful, but incomplete by itself. A reviewer agent can catch suspicious reasoning, hallucinated assumptions, or prompt injection symptoms, but it is still an LLM and can be influenced or wrong.

Recommended architecture:

```text
OpenClaw / Hermes Agent
  -> Guarded Tool Adapter / MCP / CLI wrapper
  -> Intent Normalizer
  -> Reviewer Agent
  -> Policy Engine
  -> Execution Broker
  -> CEX Connector / Onchain Signer
  -> Audit Log / Monitoring / Kill Switch
```

The agent should never directly hold:

- CEX API keys
- Wallet private keys
- LLM provider API keys if proxy injection is available
- Raw unrestricted RPC access
- Direct exchange API access
- Direct access to internal network services

The agent should only submit structured trading intents.

Example intent:

```json
{
  "action": "cex.place_order",
  "exchange": "binance",
  "account": "subaccount-1",
  "symbol": "ETH-USDC",
  "side": "buy",
  "orderType": "limit",
  "maxNotionalUsd": 500,
  "maxSlippageBps": 30,
  "rationale": "Strategy rule triggered after market snapshot review.",
  "evidence": ["market_snapshot_id", "strategy_rule_id"]
}
```

The broker should revalidate live state before execution. The agent's claim about prices, balances, positions, or chain state must not be trusted as authoritative.

## Reference Material

Useful references raised during planning:

- Docker OpenClaw sandbox article: https://www.docker.com/blog/run-openclaw-securely-in-docker-sandboxes/
- ClawSec Monitor: https://github.com/chrisochrisochriso-cmyk/clawsec-monitor
- SlowMist Agent Security: https://github.com/slowmist/slowmist-agent-security
- SlowMist OpenClaw Security Practice Guide: https://github.com/slowmist/openclaw-security-practice-guide
- Open Policy Agent / Rego for policy-as-code: https://www.openpolicyagent.org/docs/latest/policy-language/
- AWS IAM policy model as inspiration for principal/action/resource/condition policies: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html

Important design idea from the Docker OpenClaw article:

- Put API keys behind a network proxy so the agent runtime does not directly possess them and cannot leak them verbatim.

For trading keys, use an even stricter version of that idea:

- LLM API keys may be injected by an outbound proxy.
- CEX API keys and wallet secrets should not be injected into the agent at all.
- Trading keys should live only in an execution broker, signing service, KMS, HSM, MPC signer, or another tightly scoped secret boundary.

## Threat Model

### 1. Model Hallucination

Risk:

- Agent invents price, balance, position, strategy signal, contract safety, or transaction outcome.
- Agent misreads stale data or assumes an order succeeded.
- Agent overtrades after a false signal.

Controls:

- Require structured intent, not free-form execution.
- Require evidence IDs such as market snapshot ID, strategy rule ID, portfolio snapshot ID, simulation result ID.
- Broker must fetch authoritative state before execution.
- Apply limits for max notional, slippage, daily loss, position delta, order frequency, liquidation risk, and strategy scope.
- Use dry-run and simulation before live execution.
- Fail closed when data is stale, missing, contradictory, or unverifiable.

### 2. Prompt Injection

Risk:

- External text tells the agent to ignore rules, reveal secrets, install tools, change strategy, or submit dangerous trades.
- Malicious webpages, repositories, social posts, contract metadata, token descriptions, or bridge UIs manipulate the agent.

Controls:

- Treat all external content as untrusted data.
- Separate instructions from retrieved content in the adapter layer.
- Do not allow external content to modify policy, tool permissions, keys, allowlists, or risk limits.
- Require reviewer agent verdict for suspicious content.
- Require deterministic policy approval after reviewer verdict.
- Pin and scan skills, plugins, MCP servers, and tool definitions.
- Disable dynamic tool installation in production unless explicitly approved.

### 3. Host or Runtime Compromise

Risk:

- Agent container or host is compromised.
- Malware reads environment variables, local files, Docker socket, metadata service, SSH agent, cloud credentials, or internal services.
- Compromised runtime exfiltrates data over arbitrary network paths.

Controls:

- Run agent in Docker sandbox or stronger isolation such as microVMs.
- Run as non-root.
- Use read-only filesystems where possible.
- Do not mount Docker socket.
- Do not mount host home directory, SSH keys, cloud credentials, browser profiles, or wallet files.
- Use seccomp, AppArmor, capabilities drop, and resource limits.
- Use egress allowlists through network proxy or firewall.
- Block internal IP ranges, metadata endpoints, and local network access by default.
- Keep broker, signer, and secret manager outside the agent sandbox.

### 4. API Key and Wallet Secret Leakage

Risk:

- Agent prints, logs, sends, embeds, or trades away secrets.
- Prompt injection asks for keys.
- Tool call sends keys to a remote URL.
- Wallet private key is copied from environment or local files.

Controls:

- Do not provide CEX keys or wallet private keys to the agent runtime.
- Store CEX keys only in broker or secret manager.
- Store wallet keys only in signer, KMS, HSM, MPC system, or hardware-backed key service.
- Use exchange subaccounts.
- Disable withdrawal permissions on CEX keys.
- Use IP allowlists for CEX API keys.
- Use least-privilege API scopes.
- Add secret scanning and output filtering for logs.
- Redact secrets at proxy, broker, and observability layers.
- Rotate keys and support emergency revocation.

### 5. Trading Execution Abuse

Risk:

- Agent submits technically valid but economically unsafe trades.
- Agent interacts with malicious contracts.
- Agent signs unlimited token approvals.
- Agent bridges funds to attacker-controlled destinations.

Controls:

- Use policy tiers by action type.
- For CEX: restrict symbols, order types, notional size, leverage, margin mode, withdrawal access, and account.
- For onchain: restrict chains, protocols, contracts, functions, token approvals, spender addresses, slippage, destination addresses, and calldata classes.
- Simulate onchain transactions before signing.
- Reject unknown contracts by default.
- Reject unlimited approvals by default.
- Require human approval for large transfers, new contract addresses, bridges, leverage, or withdrawals.

## Recommended Architecture

### Component 1: Agent Adapter Layer

Purpose:

- Provide a common interface for OpenClaw and Hermes Agent.
- Expose only safe tools.
- Convert agent output into strict schema-validated trading intents.

Possible interfaces:

- MCP server
- CLI wrapper
- HTTP local service
- SDK package

Recommendation:

- Start with a small HTTP or CLI adapter plus schema validation.
- Add MCP support early if OpenClaw and Hermes workflows benefit from native tool integration.

### Component 2: Intent Normalizer

Purpose:

- Accept only structured requests.
- Validate required fields.
- Reject ambiguous, free-form, or underspecified actions.

Responsibilities:

- JSON schema validation.
- Canonical action names.
- Asset, chain, symbol, exchange, and account normalization.
- Reference IDs for evidence and snapshots.
- Idempotency keys.

### Component 3: Reviewer Agent

Purpose:

- Provide semantic review before policy evaluation.
- Detect suspicious reasoning, prompt injection, unsupported claims, risky behavior, and mismatch between evidence and proposed action.

Important constraint:

- Reviewer output is advisory.
- Reviewer cannot sign, trade, approve secrets, or bypass policy.

Reviewer output should be structured:

```json
{
  "verdict": "approve | reject | needs_human",
  "riskLevel": "low | medium | high | critical",
  "reasons": ["..."],
  "detectedIssues": ["prompt_injection", "unsupported_claim"],
  "requiredPolicyTags": ["cex.low_notional", "fresh_market_data"]
}
```

### Component 4: Policy Engine

Purpose:

- Act as final deterministic authorization layer.

Recommended model:

- IAM-like policy schema:
  - principal
  - action
  - resource
  - condition
  - effect
- OPA/Rego or equivalent policy-as-code engine for evaluation.

Example policy concepts:

- `agent.openclaw.strategy-alpha` can call `cex.place_order`.
- Only on `binance/subaccount-1`.
- Only for `ETH-USDC` and `BTC-USDC`.
- Max notional USD 500 per order.
- Max daily notional USD 2,000.
- Max daily realized loss USD 200.
- Leverage disabled.
- Withdrawals always denied.
- Unknown onchain contracts denied.
- Human approval required for new spender addresses.

### Component 5: Execution Broker

Purpose:

- Be the only component allowed to call CEX APIs or signing services.
- Revalidate state.
- Enforce policy result.
- Execute or reject.

Responsibilities:

- CEX order placement.
- Onchain transaction preparation.
- Live portfolio and balance checks.
- Market data freshness checks.
- Slippage and price bound checks.
- Rate limiting.
- Idempotency.
- Kill switch.
- Audit logging.

### Component 6: Secret and Signing Boundary

Purpose:

- Keep secrets away from agent processes.

CEX recommendation:

- Use subaccounts.
- Use no-withdrawal API keys.
- Use IP allowlists.
- Store keys in broker-side secret manager.
- Rotate and revoke quickly.

Onchain recommendation:

- Use signer service with strict policy.
- Prefer KMS, HSM, MPC, hardware-backed signing, or multisig for higher-value wallets.
- Agent should never see private keys or raw seed phrases.
- Signer should receive typed transaction requests and policy context, not arbitrary agent text.

### Component 7: Network Proxy and Firewall

Purpose:

- Constrain egress and optionally inject non-trading API credentials.

Controls:

- Allowlist LLM providers.
- Allowlist guardrail API.
- Allowlist explicitly approved data sources.
- Block CEX APIs and RPC nodes from agent containers.
- Block metadata service endpoints.
- Block RFC1918/internal network ranges unless explicitly required.
- Log DNS and egress attempts.
- Use proxy-level secret injection for LLM API calls where appropriate.

### Component 8: Audit Log and Monitoring

Purpose:

- Make every decision explainable and reconstructable.

Log:

- Agent identity.
- Prompt/session ID.
- Input data references.
- Intent JSON.
- Reviewer verdict.
- Policy input and output.
- Broker checks.
- CEX order ID or transaction hash.
- State before and after execution.
- Human approval details.

Recommended property:

- Append-only log.
- Hash-chain entries or external immutable storage for tamper evidence.

## Implementation Options

### Option A: Prompt-Only Guardrails

Description:

- Add system prompts and reviewer prompt templates.
- Rely on agent self-control and LLM review.

Pros:

- Fastest to prototype.
- Low engineering cost.
- Easy to support multiple agents.

Cons:

- Weakest security.
- Prompt injection remains high risk.
- No reliable protection against compromised runtime.
- Cannot safely protect keys or wallet secrets.
- Not appropriate for real-money trading.

Fit:

- Demo only.

### Option B: Sidecar Guardrail Service + Policy-as-Code + Broker

Description:

- Put a guardrail service between agents and execution.
- Agents submit structured intents.
- Reviewer agent performs semantic review.
- Policy engine makes deterministic authorization decisions.
- Broker handles CEX and onchain execution.

Pros:

- Good balance of security, delivery speed, and extensibility.
- Compatible with OpenClaw and Hermes Agent.
- Keeps trading credentials out of agent runtime.
- Clear auditability.
- Testable policy layer.
- Can support paper trading first and live trading later.

Cons:

- More engineering work than prompt-only guardrails.
- Requires careful schema, policy, and broker design.
- Needs operational work for network and secret boundaries.

Fit:

- Recommended MVP and production path.

### Option C: Custody-Grade Architecture With MPC/HSM/Multisig From Day One

Description:

- Build around institutional signing infrastructure, MPC, HSM, hardware wallets, multisig governance, and strict transaction workflows.

Pros:

- Strongest secret protection.
- Better for large funds and institutional workflows.
- Cleaner separation between strategy and custody.

Cons:

- Highest cost and complexity.
- Slower MVP.
- More vendor and operations dependencies.
- May overfit early before product requirements stabilize.

Fit:

- Best as later hardening for high-value deployment.

## Recommendation

Implement Option B first: Sidecar Guardrail Service + Policy-as-Code + Execution Broker.

Why this wins:

- It makes the agent replaceable. OpenClaw and Hermes can both integrate through adapters.
- It prevents the agent from directly holding secrets.
- It allows reviewer-agent intelligence without trusting it as the final boundary.
- It provides deterministic enforcement for risk, identity, action, and resource constraints.
- It creates an audit trail suitable for debugging, red-teaming, and compliance-style review.
- It can start with paper trading and evolve into live trading without rewriting the core control plane.

Recommended MVP should support:

- OpenClaw adapter.
- Hermes Agent adapter.
- Structured trading intent schema.
- Reviewer agent verdict.
- Policy evaluation.
- CEX paper trading broker.
- Onchain testnet signer.
- Append-only audit log.
- Basic egress allowlist for agent runtime.

## Phased Execution Plan

### Phase 0: Threat Model and Specification

Deliverables:

- Threat model document.
- Trading intent JSON schemas.
- Policy schema.
- Risk tier definitions.
- Supported action list.
- Initial allow/deny matrix.

Validation:

- Review example attack paths:
  - hallucinated price
  - prompt injection from webpage
  - malicious plugin/tool
  - leaked env var attempt
  - unauthorized withdrawal
  - unknown onchain contract

### Phase 1: Core Guardrail API

Deliverables:

- Guardrail service skeleton.
- Intent validation endpoint.
- Reviewer verdict interface.
- Policy evaluation interface.
- Audit logging.
- Idempotency key support.

Validation:

- Unit tests for schema validation.
- Policy tests for allow/deny cases.
- Audit log completeness tests.

### Phase 2: Broker MVP

Deliverables:

- CEX paper trading broker.
- Onchain testnet transaction simulator/signer.
- Market data freshness checks.
- Portfolio and balance snapshot support.
- Kill switch.

Validation:

- End-to-end paper order flow.
- Rejection for stale market data.
- Rejection for over-limit notional.
- Rejection for unknown contract.
- Rejection for unlimited approval.

### Phase 3: Agent Integrations

Deliverables:

- OpenClaw adapter.
- Hermes Agent adapter.
- Tool definitions that expose only guarded actions.
- Example strategies.

Validation:

- Agent can propose a valid trade.
- Agent cannot access keys.
- Agent cannot call CEX/RPC directly.
- Agent receives structured reject reasons.

### Phase 4: Runtime Isolation and Network Controls

Deliverables:

- Docker sandbox profile.
- Non-root agent container.
- Read-only mounts where possible.
- Egress proxy.
- Firewall allowlist.
- Secret injection only at proxy or broker layer.
- Blocked metadata and internal network ranges.

Validation:

- Attempted arbitrary egress is blocked.
- Attempted CEX/RPC direct access from agent is blocked.
- Attempted env secret exfiltration has no useful trading secrets.
- Agent container cannot access Docker socket or host credentials.

### Phase 5: Red Team and Hardening

Deliverables:

- Prompt injection test suite.
- Secret exfiltration test suite.
- Malicious tool/plugin test suite.
- Trading abuse test suite.
- RPC inconsistency test suite.
- Incident response runbook.

Validation:

- Fail-closed behavior under malformed inputs.
- Human approval gates work.
- Key revocation works.
- Kill switch works.
- Logs are sufficient to reconstruct every decision.

## Policy Design Notes

Use an IAM-inspired model:

```json
{
  "effect": "allow",
  "principal": "agent.openclaw.strategy-alpha",
  "action": "cex.place_order",
  "resource": "cex:binance:subaccount-1:ETH-USDC",
  "condition": {
    "maxNotionalUsd": 500,
    "maxSlippageBps": 30,
    "leverageAllowed": false,
    "requiresFreshMarketDataSeconds": 10
  }
}
```

Policy should be evaluated with explicit deny precedence:

1. If any deny rule matches, reject.
2. If required reviewer status is not satisfied, reject or require human approval.
3. If no allow rule matches, reject.
4. If dynamic risk checks fail, reject.
5. Otherwise, allow broker execution.

## Onchain-Specific Guardrails

Minimum controls:

- Chain allowlist.
- Contract allowlist.
- Function selector allowlist.
- Token allowlist.
- Spender allowlist.
- Destination address allowlist or risk scoring.
- Max native/token amount.
- Max approval amount.
- Reject unlimited approvals by default.
- Reject delegatecall/proxy interaction unless reviewed.
- Simulate transaction before signing.
- Compare expected balance deltas with simulated deltas.

Human approval should be required for:

- New contract address.
- New spender.
- Bridge transaction.
- Large transfer.
- Governance action.
- Token approval above threshold.
- Any transaction with unclear simulation result.

## CEX-Specific Guardrails

Minimum controls:

- Exchange allowlist.
- Account/subaccount allowlist.
- Symbol allowlist.
- Order type allowlist.
- Max notional per order.
- Max daily notional.
- Max position size.
- Max realized/unrealized loss.
- Slippage/price band checks.
- Leverage disabled by default.
- Withdrawals denied.
- Transfer between accounts denied unless explicitly allowed.
- Cooldown after repeated rejections or losses.

## RPC Eclipse and BGP Split Future Work

Future architecture:

```text
Broker / Signer
  -> RPC Quorum Service
      -> Provider A
      -> Provider B
      -> Self-hosted node
      -> Archive or fallback provider
```

Controls:

- Use multiple RPC providers across different networks and regions.
- Include at least one self-hosted node for important chains.
- Compare chain ID, latest block number, block hash, finalized checkpoint, gas data, and account state.
- Require quorum before signing or broadcasting high-risk transactions.
- Fail closed when providers disagree beyond configured tolerance.
- Broadcast through multiple paths when appropriate.
- Confirm transaction inclusion from multiple independent sources.

## Open Questions

- Which language should be used for the first implementation: TypeScript, Python, Rust, or Go?
You can decide. We aim at security and also need to support the above design.
- Should the first integration target OpenClaw or Hermes Agent?
Both.
- Which CEX should be supported first?
Binance.
- Which chain should be supported first for onchain testnet execution?
Ethereum and Solana.
- Is the first target paper trading, testnet, or limited live trading?
I guess we can go straight for limited live trading? But you can decide.
- What value threshold requires human approval?
Should be configurable.
- Should OPA/Rego be embedded from day one, or should the MVP start with a simpler policy evaluator and migrate to OPA?
You can decide. But if you decide to start with a simpler policy evaluator, you need to document clearly how to migrate to OPA.
- Which secret backend should be used first: local dev secrets, cloud secret manager, Vault, KMS, HSM, or MPC provider?
I think at the end we need to support them all?
- What deployment target is assumed: local Docker, single VPS, Kubernetes, or cloud-managed runtime?
I think at the end we need to support them all?
