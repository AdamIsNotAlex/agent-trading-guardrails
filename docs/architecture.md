# Architecture

## Overview

The Agent Trading Guardrails framework uses a Sidecar Guardrail Service + Policy-as-Code + Execution Broker architecture. AI agents submit structured trading intents through a guarded tool adapter. Every intent passes through schema validation, semantic review, deterministic policy evaluation, dynamic risk checks, and broker-side revalidation before execution.

## Components

### Agent Adapter Layer

Provides a common interface for OpenClaw and Hermes Agent. Exposes only safe, guarded tools. Converts agent output into strict schema-validated trading intents.

### Intent Normalizer

Accepts only structured requests. Validates required fields. Rejects ambiguous, free-form, or underspecified actions. Enforces canonical action names, asset normalization, evidence references, and idempotency keys.

### Reviewer Agent

Provides semantic review before policy evaluation. Detects suspicious reasoning, prompt injection, unsupported claims, risky behavior, and mismatch between evidence and proposed action. The reviewer verdict is advisory — it cannot sign, trade, approve secrets, or bypass policy.

### Policy Engine (OPA/Rego)

Final deterministic authorization layer. Uses an IAM-inspired model with principal, action, resource, condition, and effect. Evaluates with explicit deny precedence:

1. If any deny rule matches, reject.
2. If required reviewer status is not satisfied, reject or escalate to human approval.
3. If no allow rule matches, reject.
4. If dynamic risk checks fail, reject.
5. Otherwise, allow broker execution.

### Dynamic Risk Engine

Performs live data checks that are awkward to express in Rego: market data freshness, portfolio freshness, per-order notional, daily notional, daily loss, slippage, position delta, order frequency, and evidence reference validation.

### Execution Broker

The only component allowed to call CEX APIs or signing services. Revalidates state before execution. Enforces policy result. Handles idempotency, kill switch, and audit logging.

### Secret and Signing Boundary

CEX API keys live only in the broker or secret manager (Vault). Wallet private keys live only in the signer, KMS, HSM, or MPC system. The agent runtime never sees secrets.

### Network Proxy and Firewall

Constrains agent egress. Allowlists LLM providers and guardrail API. Blocks CEX APIs, RPC endpoints, metadata services, and internal network ranges from agent containers.

### Audit Log

Append-only SQLite with hash-chain tamper evidence. Records every decision point: intent receipt, validation, reviewer verdict, policy evaluation, risk checks, broker revalidation, execution result, and human approval details.

## Data Flow

```
Agent proposes structured intent
  → Schema validation (Zod)
  → Reviewer agent returns structured verdict
  → TypeScript normalizes facts for OPA
  → OPA/Rego evaluates policy (allow | deny | needs_human)
  → Dynamic risk engine checks live state
  → Broker revalidates and executes (or rejects)
  → Audit log records full decision chain
```

## Environment Profiles

| Profile | Execution Mode |
|---------|---------------|
| `dev` | Mock connectors, no real execution |
| `paper` | Simulated execution against live market data |
| `testnet` | Real testnet transactions (Sepolia, Solana devnet) |
| `canary_live` | Real execution with tight canary limits |
| `production` | Full production trading |
