# Security Boundaries

## Core Principle

The agent runtime is untrusted. It may be compromised, manipulated by prompt injection, or produce hallucinated outputs. Every security-critical operation must be enforced outside the agent runtime by deterministic systems. The Linux Docker Compose stack enforces the local network and filesystem boundary described below; it does not protect against a compromised Docker host or replace production caller authentication and custody controls.

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

When the required sandbox, network, and filesystem controls are deployed, the agent must not be able to:

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
| Direct Agent LLM API keys | Not provisioned in local Compose | Agent submits intents only; no direct LLM route |
| Reviewer API keys | Secret manager | Guardrail service reads at review time |

## Network Controls

Local Compose enforces these controls using internal bridges, dedicated network namespaces, nftables, a fixed-route reverse proxy, and controlled DNS. Setting proxy environment variables alone is not the boundary: an Agent that ignores them still cannot open a direct exchange/RPC, metadata, host-gateway, private-network, or arbitrary internet connection. Rules run inside the sandbox namespace, not in host-global `DOCKER-USER`/UFW chains.

The standalone HTTP endpoints are development interfaces without caller authentication. Loopback
bindings and private Compose networks are intentional defaults, not a substitute for authenticated
identity. Before remote deployment, put the APIs behind an authenticated gateway (for example,
mTLS) that binds the caller to the permitted `principal`. A supplied `x-correlation-id` is trace
metadata, never authorization. Do not expose OPA or `/execute` directly to untrusted networks.

Agent shares only the **network namespace** of `agent-sandbox`; it has a different PID/filesystem namespace, a non-root user, a read-only root, no capabilities, and `no-new-privileges`. Only the trusted sandbox helper has `NET_ADMIN`, `NET_BIND_SERVICE`, and `SETGID` (dnsmasq initializes its group list). Agent receives only `GUARDRAIL_URL` and a read-only resolver configuration—not reviewer keys, decision secrets, risk snapshots, audit/log volumes, signer keys, or Docker sockets. The JSONL entrypoint does not load `.env`.

- Agent OUTPUT defaults to deny. Exceptions: loopback DNS and `172.30.10.20:8080`, whose only routes are Guardrail `/health` and `/evaluate`. No generic HTTP forwarding, CONNECT, Broker route, or direct LLM route exists.
- A separate raw OUTPUT hook blocks Docker's `127.0.0.11` resolver **before DNAT**. Tracked traffic filtering follows conntrack at filter priority; IPv6 and all forwarding are denied. The helper installs a default route to the internal bridge only after lockdown so literal-IP attempts reach OUTPUT and can be logged, rather than failing before netfilter with `ENETUNREACH`.
- Agent DNS answers only the exact `egress-proxy` record. Unknown names, including CEX/RPC names and subdomains, receive NXDOMAIN without external queries. External UDP/TCP DNS and DNS-over-HTTPS bypasses have no allowed network path.
- Guardrail's reviewer uses the separate `172.30.20.10:8081` listener. It forwards only POST `/v1/chat/completions` to `api.openai.com:443`, with TLS certificate and hostname verification. Only the egress helper's resolver can use `1.1.1.1:53`; DNS allows that exact provider name, rejects rebind answers and other names, and the egress firewall also rejects non-global/private destinations. Guardrail holds the reviewer key; the proxy neither exposes it to Agent nor logs request bodies/Authorization headers.
- Broker, Signer, and optional dev Vault are on a separate internal execution network. Signer has no published port or internet route. Paper execution does not broadcast signed transactions. Risk snapshots remain a trusted producer's responsibility.
- DNS queries/replies, NFLOG packet drops, and proxy access/errors have separate persistent named volumes. Rotation runs every minute (10 MiB trigger, five network-log/seven proxy-log rotations; not a hard disk quota). Agent cannot mount or erase these logs. See the deployment guide for inspection and backups.
- Startup is fail-closed if firewall, DNS, or packet logging cannot initialize. On observed child failure or ordinary termination, the helper reinstalls lockdown. An uncatchable SIGKILL leaves the installed rules in force but cannot run shutdown cleanup; treat unhealthy helpers as an incident and recreate the sandbox and its dependent app together. Do not restart only a namespace owner and leave dependents attached to an obsolete namespace.

| Local Compose direction | Agent | Guardrail | Broker / Signer |
|-------------------------|-------|-----------|-----------------|
| Guardrail API | Fixed proxy only | Local listener | Not connected |
| LLM provider | Blocked | Fixed reviewer proxy only | No internet route |
| CEX / RPC | Blocked | No internet route | No internet route; paper / offline signing only |
| Broker / Signer / OPA / Vault | Blocked | OPA network only | Execution network only |
| Metadata / arbitrary internet | Blocked by namespace firewall | No internet route | No internet route |

The trusted services still share their explicitly assigned internal bridges; this is not a general-purpose zero-trust service mesh. Public deployments additionally need authenticated principals, operational log monitoring/backups, trusted risk data, and production signing infrastructure.
