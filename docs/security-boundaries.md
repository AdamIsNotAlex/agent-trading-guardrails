# Security Boundaries

## Core Principle

The agent runtime is untrusted. It may be compromised, manipulated by prompt injection, or produce hallucinated outputs. Every security-critical operation must be enforced outside the agent runtime by deterministic systems.

## Boundary Map

```
┌─────────────────────────────────────┐
│         Agent Sandbox               │
│  (OpenClaw / Hermes Agent)          │
│                                     │
│  ✗ No CEX API keys                  │
│  ✗ No wallet private keys           │
│  ✗ No direct exchange access        │
│  ✗ No direct RPC access             │
│  ✗ No internal network access       │
│  ✗ No Docker socket                 │
│  ✗ No host credentials              │
│                                     │
│  ✓ Guarded tool adapter only        │
│  ✓ Structured intent submission     │
│  ✓ Structured rejection reasons     │
└──────────────┬──────────────────────┘
               │ Structured intents only
               ▼
┌─────────────────────────────────────┐
│      Guardrail Service              │
│                                     │
│  Schema validation (Zod)            │
│  Reviewer agent (advisory)          │
│  Policy engine (OPA/Rego)           │
│  Dynamic risk engine                │
│  Human approval orchestration       │
└──────────────┬──────────────────────┘
               │ Approved decisions only
               ▼
┌─────────────────────────────────────┐
│      Execution Broker               │
│                                     │
│  State revalidation                 │
│  Kill switch enforcement            │
│  Idempotency                        │
│  Audit logging                      │
└──────────────┬──────────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
┌──────────────┐ ┌──────────────┐
│ CEX Connector│ │ Onchain      │
│ (Binance)    │ │ Signer       │
│              │ │              │
│ Keys in      │ │ Keys in      │
│ Vault/secret │ │ KMS/HSM/MPC  │
│ manager      │ │ or signer    │
└──────────────┘ └──────────────┘
```

## What the Agent Cannot Do

- Access CEX API keys or wallet private keys
- Call exchange APIs directly
- Call RPC endpoints directly
- Access signing services directly
- Modify policy bundles
- Write to audit logs
- Disable the kill switch
- Access the Docker socket, host filesystem, SSH keys, cloud credentials, or browser profiles
- Reach internal network services or metadata endpoints

## What the Agent Can Do

- Submit structured trading intents through the guarded tool adapter
- Receive structured rejection reasons
- Query order status through guarded read-only endpoints

## Secret Isolation

| Secret Type | Storage | Access Path |
|------------|---------|-------------|
| CEX API keys | Vault / secret manager | Broker reads at execution time |
| Wallet private keys | Signer / KMS / HSM / MPC | Signer reads at signing time |
| LLM API keys | Proxy / secret manager | Injected by outbound proxy |
| Reviewer API keys | Secret manager | Guardrail service reads at review time |

## Network Controls

| Direction | Agent Runtime | Broker/Signer |
|-----------|--------------|---------------|
| LLM providers | Allowed (via proxy) | N/A |
| Guardrail service | Allowed | N/A |
| CEX APIs | Blocked | Allowed |
| RPC endpoints | Blocked | Allowed |
| Internal network | Blocked | Restricted |
| Metadata services | Blocked | Blocked |
| Arbitrary internet | Blocked | Blocked |
