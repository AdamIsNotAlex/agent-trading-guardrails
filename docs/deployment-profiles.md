# Deployment Profiles

## Overview

The framework supports multiple deployment profiles. Each profile defines how components are deployed, how secrets are managed, and what network controls are enforced.

## Local Docker (Development)

- Default Compose starts Agent (JSON Lines), Guardrail HTTP, the paper Broker, the offline Sepolia Signer, OPA, a fixed-route egress proxy, and two firewall/DNS/logging helpers. The optional `dev` profile adds dev Vault.
- Agent, Guardrail, Broker, Signer, and proxy run as non-root users with read-only roots and no capabilities. Only the two trusted network helpers have `NET_ADMIN`, `NET_BIND_SERVICE`, and `SETGID`; Agent cannot modify their rules or access their filesystem/PID namespaces.
- Agent is attached only to its sandbox namespace. It can use its controlled loopback DNS and the proxy's Guardrail `/health` and `/evaluate` routes. It cannot reach Broker, Signer, OPA, Vault, direct CEX/RPC endpoints, metadata, host gateways, private networks, external DNS, or arbitrary public IPs, even if it ignores proxy settings. See [Network Controls](security-boundaries.md#network-controls) for the enforced rules and trust limits.
- The proxy is **not** a forward/CONNECT proxy. A separate listener available only to Guardrail forwards reviewer chat completions to `api.openai.com` over verified TLS. Agent has no direct LLM access. `OPENAI_API_KEY` is required by Guardrail; missing credentials are a startup error, not automatic approval.
- Published Guardrail (3000), Broker (3001), OPA (8181), and optional Vault (8200) ports bind to `127.0.0.1`. Signer, DNS, and proxy have no host-published ports. Docker-published ports can bypass UFW; do not replace the loopback bindings with public interfaces.
- Broker remains **simulated dev/paper execution only**. The Signer produces real offline Sepolia transaction signatures from authorized typed requests, not broadcasts or execution receipts. Generated local keys must never be funded or reused for real custody. The stack does not enable testnet/live trading or supply an authoritative simulation/risk feed.
- Guardrail, Broker, and Signer each have independent audit databases/hash anchors. Signer keys, signing idempotency, Broker idempotency, DNS logs, packet-drop logs, and proxy logs persist in named volumes. Each audit chain has exactly one writer. Non-dev profiles require strong decision/audit secrets; this local stack refuses live profiles.

### Start locally

Requirements: rootful **Linux Docker Engine**, Compose with `gw_priority` support, and host-kernel nftables/NFLOG support. Unsupported capabilities, firewall initialization, or logging setup fail startup; there is no unconfined fallback. The helpers change only their own namespaces, not the host firewall. Node 22+ is needed on the host only for the verification script or non-container entrypoints.

Copy `env.example` to `.env`, set the reviewer key, and configure a trusted risk snapshot producer. Docker builds install and compile the workspace; host `pnpm install` is not needed for the container path.

```sh
mkdir -p data/risk
docker compose config --quiet
docker compose up --build -d --wait
node deploy/verify-local.mjs

# Submit JSONL through the running, confined Agent (no broker/signing/reviewer secrets).
docker compose exec -T agent node packages/agent-adapters/dist/main.js < intents.jsonl

# Optional development Vault, never a production vault.
docker compose --profile dev up -d vault
```

The verification script exercises the real JSONL entrypoint and Guardrail denial path, checks allowed proxy access, rejects CONNECT/unauthorized routes, probes direct sockets (metadata, private/host/service/public IPv4 and IPv6), bypass DNS resolvers, and inspects persistent logs. From the trusted Broker container it also exercises paper execution and the signing CLI with **synthetic administrative dev/paper authorizations**, verifies the real offline signature, and checks forgery/nonce-rebinding rejection. These fixtures are not evidence of a successful live reviewer/risk approval. The script sends no real orders and broadcasts no transactions. A healthy Guardrail reports OPA reachability—not successful reviewer credentials, fresh risk facts, or execution readiness.

The fixed subnets `172.30.10.0/24`, `172.30.20.0/24`, `172.30.30.0/24`, and `172.30.40.0/24` must not overlap host/VPN/other Docker networks. Service IPs are part of the security contract: changing them requires coordinated changes to Compose, `deploy/network/*`, `deploy/proxy/nginx.conf`, and the verification script. Only `egress-sandbox` has an external bridge. Agent's default route terminates at its internal bridge so failed literal-IP attempts reach NFLOG; it does not grant internet access.

After changing/recreating a namespace owner, recreate its dependent app as well (`agent-sandbox` + `agent`, `egress-sandbox` + `egress-proxy`). For a complete restart use `docker compose down` followed by `docker compose up -d --wait`; **do not add `--volumes`** unless deliberately discarding keys, audit history, idempotency, and logs. Unexpected helper failure is fail-closed and requires operator intervention, not automatic unconfined restart.

For unconfined host-only API debugging after `pnpm install && pnpm build`, run `docker compose up -d opa`, `pnpm start:service`, and `pnpm start:broker` in separate terminals. `GUARDRAIL_URL=http://127.0.0.1:3000 pnpm --silent start:agent < intents.jsonl` does not load `.env`, but **a host process has none of Compose's network isolation**. Do not treat that workflow as an Agent sandbox.

`SIGINT`/`SIGTERM` stop HTTP listeners, let in-flight requests finish, and close audit databases. Configuration/listen failures exit nonzero. The service factory remains `createGuardrailServer(service)` in `@guardrails/service`; it returns an unbound Node `http.Server` and never listens on import.

### Persistent network logs

| Named volume | Container and path | Contents |
|--------------|--------------------|----------|
| `agent-network-logs` | `agent-sandbox:/var/log/guardrails/network` | `dns.log`: local queries/NXDOMAIN replies; `blocked-egress.log`: NFLOG packet drops, including literal-IP attempts |
| `egress-network-logs` | `egress-sandbox:/var/log/guardrails/network` | Provider DNS queries/replies and denied egress/rebind packets |
| `proxy-logs` | `egress-proxy:/var/log/nginx` | JSON `access.log` and `error.log`; no request bodies or Authorization headers |

```sh
docker compose exec -T agent-sandbox cat /var/log/guardrails/network/dns.log
docker compose exec -T agent-sandbox cat /var/log/guardrails/network/blocked-egress.log
docker compose exec -T egress-proxy cat /var/log/nginx/access.log
```

Rotation runs every minute, triggered at 10 MiB, retaining five network-log and seven proxy-log rotations. Network logs use `copytruncate`; concurrent writes at the truncate boundary can be lost. Rotation is not a disk quota or remote tamper-proof collection: monitor capacity, back up/ship these named volumes, and restrict Docker/host administration. Containers' stdout/stderr also use Docker's bounded `local` log driver. Agent has no access to any of these mounts.

### HTTP contract

| Endpoint | Request | Response |
|----------|---------|----------|
| Guardrail `GET /health` | No body | `service.health()`: 200 for `ok`, 503 for `degraded`; `opaHealthy` describes OPA reachability, not readiness of every external dependency |
| Guardrail `POST /evaluate` | Raw `TradingIntent` JSON, `Content-Type: application/json` | 200 with `GuardrailDecision`; policy/risk denials are decisions, not HTTP transport failures |
| Broker `GET /health` | No body | 200 with `status: ok`, `executionMode: paper` after successful dependency construction |
| Broker `POST /execute` | Signed decision fields plus the original `intent` | 200 with `BrokerExecutionResult`; the broker still verifies the HMAC, age, environment, kill switch, approval state, and idempotency before execution |
| Signer `GET /health` (execution network only) | No body | 200 with `mode: offline-sepolia`, `chainId: 11155111`, and the persisted key's public address |
| Signer `POST /sign` (execution network only) | `SigningRequest`: original allow approval plus bounded EIP-1559 envelope | 200 with `OfflineSignature`: signed bytes and their hash, **not a broadcast/execution result**; 403 for failed authorization/caps and 409 for reused/conflicting/reserved signing state |

```sh
curl -i http://127.0.0.1:3000/evaluate \
  -H 'Content-Type: application/json' -H 'x-correlation-id: strategy-order-42' \
  --data-binary @intent.json
```

Validation failures return JSON: 400 for malformed JSON/schema/correlation IDs, 413 for a body over 1 MiB, 415 for an unsupported media type, 404 for unknown routes, and 405 with `Allow` for wrong methods. Internal failures return a generic 500 without exception details or secrets.

`x-correlation-id` accepts 1–128 characters from `[A-Za-z0-9._:-]`; omission generates a UUID. Responses echo the HTTP request ID, including application errors. Evaluation carries it into audit events and the signed decision. **Cached `needs_human` decisions retain their original body `correlationId`, `approvalId`, and token** to preserve the human-approval binding; the response header identifies the new HTTP request. Broker never replaces a signed decision's ID with its transport request ID.

For `/execute`, send `{intentId, correlationId, outcome, decidedAt, decisionToken, approvalId?, intent}` from the decision and original intent. Never generate tokens in the agent. `/evaluate` does not automatically execute. Human-approval resolution is not exposed over HTTP; process-local approval stores are not shared between standalone processes, so the broker rejects `needs_human` requests without an approved record. Use the existing in-process approval integration for that workflow.

The Agent entrypoint consumes raw intents, one JSON object per line, and prints one decision or `{error, message, correlationId?}` per nonblank line. It continues after invalid JSON/schema or failed HTTP requests and exits 1 if any submission failed; a policy denial is a successful submission, not a transport error. Requests time out after 30 seconds. EOF exits normally. This is an intent transport, not an autonomous strategy/LLM loop, and it never calls `/execute`.

### Offline Signer and Broker-side CLI

The local Signer accepts **Ethereum Sepolia only**, under `GUARDRAIL_ENV=dev` or `paper`. It signs real EIP-1559 transactions using a signer-owned persistent secp256k1 key, but has no RPC client, no internet route, and never broadcasts. This is an offline local boundary—not a live trading connector, authoritative simulation service, KMS/HSM, or production custody solution. Do not fund generated keys or treat a signature as evidence that execution/risk checks succeeded on a chain.

`POST /sign` takes exactly two fields:

- `approval`: `{intentId, correlationId, outcome: "allow", intent, decidedAt, decisionToken}` selected from the original Guardrail decision and original `TradingIntent`. No additional approval fields are accepted. The signer verifies the existing HMAC, exact intent/environment binding, and a decision age of at most five minutes; future timestamps, `needs_human`, and `approvalId` are rejected. The intent must be `onchain.request_signature`, `chain: ethereum`, `chainEnvironment: sepolia`, with a matching canonical resource. Malformed/unlimited ERC-20 approvals and amounts over the intent's approval cap are rejected.
- `transaction`: `{nonce, gas, maxFeePerGas, maxPriorityFeePerGas}`. `nonce` is a nonnegative safe integer; the other fields are canonical unsigned decimal strings, not hex, floats, signs, or leading-zero numbers. The destination, calldata, and value come **only** from the authenticated intent. Chain ID is fixed to `11155111`; arbitrary transaction/chain/destination overrides are rejected. The trusted caller supplies nonce/gas/fees; this offline process cannot confirm balances, nonce freshness, or the intent's simulation evidence against a chain.

```sh
# Trusted operator workflow; never run with service secrets inside Agent.
docker compose exec -T broker node packages/runtime/dist/sign-main.js < signing-request.json

# Host-only debugging after pnpm build (no container network boundary):
pnpm start:signer
pnpm --silent start:sign < signing-request.json
```

The CLI reads one JSON request (maximum 1 MiB), uses `SIGNER_URL`, times out after 30 seconds, and exits nonzero on refusal or malformed/unverifiable output. It verifies the recovered address, transaction hash, chain, destination, calldata, value, nonce, and fees before printing the result. The URL/network must identify the trusted signer; a self-reported address alone does not authenticate a remote service. `/execute` remains paper-only and does not implicitly call `/sign`.

`SIGNER_KEY_PATH` defaults to `./data/signer/sepolia.key`. A missing key is generated once in dev/paper, fsynced, and stored as an owner-only regular file; malformed/unsafe existing keys fail startup instead of being replaced. `SIGNER_AUDIT_DB_PATH` defaults to `./data/signer-audit.db`; `SIGNER_AUDIT_HASH_ANCHOR_PATH` defaults to `./audit-anchor/signer/head.hash`. Signing reservations/results live in that signer's SQLite database, not the Broker database. Back up keys, state, and anchor together; a replacement key with old state is rejected.

An idempotency key and intent ID are each bound to one complete approved envelope; the wallet nonce is unique across requests. Exact retries return the verified cached signature. Changed envelopes, reused nonces/intent IDs, or crash/audit-failure reservations return 409 and require operator investigation—never deleting state and blindly retrying. Requests and completions are audited before a result is published; raw private keys and signed transaction bytes are not audit payloads.

Default caps are `SIGNER_MAX_GAS=1000000`, `SIGNER_MAX_FEE_PER_GAS=100000000000` wei/gas, and `SIGNER_MAX_TOTAL_FEE_WEI=10000000000000000` wei. Gas must be at least 21,000, priority fee cannot exceed max fee, and `gas * maxFeePerGas` must fit the aggregate ceiling. The same variables are explicitly passed through Compose; all must be positive uint256 decimal values.

### Runtime configuration and risk data

`GUARDRAIL_HOST`/`GUARDRAIL_PORT` default to `127.0.0.1:3000`; `BROKER_HOST`/`BROKER_PORT` to `127.0.0.1:3001`; `SIGNER_HOST`/`SIGNER_PORT` to `127.0.0.1:3002`. Images explicitly bind to `0.0.0.0` inside their private networks. `OPA_URL`, `REVIEWER_PROVIDER=openai`, `REVIEWER_MODEL`, `OPENAI_API_KEY`, `GUARDRAIL_ENV`, `GUARDRAIL_DECISION_SECRET`, and `APPROVAL_TIMEOUT_SECONDS` configure evaluation. Guardrail, Broker, and Signer must use the same environment and decision secret. Compose fixes `OPENAI_BASE_URL` to the private reviewer proxy; host-only debugging uses the SDK's normal provider endpoint unless explicitly configured otherwise.

`GUARDRAIL_AUDIT_DB_PATH` and `BROKER_AUDIT_DB_PATH` default to `./data/guardrail-audit.db` and `./data/broker-audit.db`; corresponding `*_AUDIT_HASH_ANCHOR_PATH` variables select separate anchors. Generic `AUDIT_DB_PATH`/`AUDIT_HASH_ANCHOR_PATH` remain usable when configuring just one process. Never point two processes at the same chain. `BROKER_IDEMPOTENCY_PATH` defaults to `./data/broker-idempotency.json`; preserve it across restarts. `BROKER_KILL_SWITCH=true` starts the broker with its global kill switch active.

`RISK_DATA_PATH` defaults to `./data/risk/risk-snapshot.json`. Compose mounts the host `./data/risk` directory read-only into Guardrail. A trusted feed outside the agent must atomically replace this JSON file. Each evaluation reads one consistent snapshot and applies `DEFAULT_CANARY_LIVE_LIMITS`; missing, malformed, mismatched, future-dated, or stale facts fail closed. The runtime never substitutes intent prices for market data or synthesizes successful risk checks.

Snapshot shape (illustrative values only; timestamp `0` is intentionally stale):

```json
{
  "marketData": [{ "symbol": "ETH-USDC", "price": 3500, "timestampMs": 0 }],
  "portfolios": [{ "account": "subaccount-1", "timestampMs": 0, "positions": [] }],
  "dailyStats": [{ "account": "subaccount-1", "date": "2026-10-09", "totalNotionalUsd": 0, "realizedLossUsd": 0, "orderCount": 0 }],
  "lastOrderTimestamps": { "subaccount-1": null }
}
```

Positions have `{symbol, quantity, notionalUsd}`. `dailyStats.date` must match the current UTC date. An explicit `null` last-order timestamp means the trusted feed knows there were no previous orders; an absent account is unavailable, not an empty history. Refresh timestamps only when the underlying facts have actually been refreshed. The snapshot producer must incorporate execution activity; the reader is not an exchange feed or accounting writer.

## Single VPS

- All components on one machine.
- Vault with single-node integrated storage and documented backup/unseal workflow.
- Agent isolated via Docker with network controls.
- Egress proxy/firewall for agent container.
- SQLite audit database with regular backups.

### Single VPS Vault configuration

Use Vault integrated storage instead of dev mode. Keep TLS material and unseal keys outside the application containers. This example binds Vault to loopback; non-agent services should reach it through host networking, Vault Agent/file-injected secrets, or an explicitly secured local proxy/listener with matching TLS SANs and firewall rules rather than by exposing Vault on a broad interface.

```hcl
storage "raft" {
  path    = "/opt/vault/data"
  node_id = "guardrails-vps-1"
}

listener "tcp" {
  address       = "127.0.0.1:8200"
  tls_cert_file = "/etc/vault/tls/vault.crt"
  tls_key_file  = "/etc/vault/tls/vault.key"
}

api_addr     = "https://127.0.0.1:8200"
cluster_addr = "https://127.0.0.1:8201"
ui           = false
```

Operational setup:

1. Create `/opt/vault/data` owned by the Vault service user with mode `0700`.
2. Start Vault under systemd with `VAULT_ADDR=https://127.0.0.1:8200`; the Vault certificate must include `127.0.0.1` as an IP SAN, or use a DNS name with a matching SAN.
3. Run `vault operator init` once; split unseal keys across operators and store the root token in an offline break-glass location.
4. Unseal with the quorum of unseal keys after every restart.
5. Enable the `kv-v2` secrets engine at the `kv` mount with `vault secrets enable -path=kv kv-v2`.
6. Issue least-privilege policies per component; runtime services must not use the root token.

Backup wrapper example:

```sh
#!/bin/sh
set -eu
umask 077
export VAULT_ADDR="https://127.0.0.1:8200"
export VAULT_CACERT="/etc/vault/tls/ca.crt"
. /etc/vault/snapshot.env
install -d -m 0700 -o vault -g vault /var/backups/vault
vault operator raft snapshot save "/var/backups/vault/raft-$(date +%F).snap"
find /var/backups/vault -type f -mtime +14 -delete
```

Run the wrapper as root from cron with `VAULT_TOKEN` set in `/etc/vault/snapshot.env` as a root-owned `0600` file, not with the root token. The token policy needs only the snapshot capability, for example `path "sys/storage/raft/snapshot" { capabilities = ["read"] }`. Store snapshots on encrypted storage and periodically restore one into a non-production Vault to verify backup integrity.

## Kubernetes

- Components deployed as separate pods/services.
- Vault Helm deployment with integrated Raft storage and HA mode.
- Agent pods with network policies restricting egress.
- OPA as sidecar or dedicated service.
- Persistent volume for audit database.

### Kubernetes Vault Helm values

Use the official Vault Helm chart with integrated Raft HA and persistent volumes. The example assumes Helm release `guardrails-vault` in namespace `vault`; if either changes, update `retry_join`, `leader_tls_servername`, TLS SANs, and anti-affinity labels together.

```yaml
global:
  tlsDisable: false

server:
  extraEnvironmentVars:
    VAULT_CACERT: /vault/userconfig/vault-tls/ca.crt
  ha:
    enabled: true
    replicas: 3
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = false

        listener "tcp" {
          address = "[::]:8200"
          cluster_address = "[::]:8201"
          tls_disable = 0
          tls_cert_file = "/vault/userconfig/vault-tls/tls.crt"
          tls_key_file = "/vault/userconfig/vault-tls/tls.key"
          tls_client_ca_file = "/vault/userconfig/vault-tls/ca.crt"
        }

        storage "raft" {
          path = "/vault/data"

          retry_join {
            leader_api_addr = "https://guardrails-vault-0.guardrails-vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-tls/ca.crt"
            leader_tls_servername = "guardrails-vault.vault.svc.cluster.local"
          }

          retry_join {
            leader_api_addr = "https://guardrails-vault-1.guardrails-vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-tls/ca.crt"
            leader_tls_servername = "guardrails-vault.vault.svc.cluster.local"
          }

          retry_join {
            leader_api_addr = "https://guardrails-vault-2.guardrails-vault-internal:8200"
            leader_ca_cert_file = "/vault/userconfig/vault-tls/ca.crt"
            leader_tls_servername = "guardrails-vault.vault.svc.cluster.local"
          }
        }

        service_registration "kubernetes" {}
  dataStorage:
    enabled: true
    size: 20Gi
    storageClass: "standard-rwo"
  extraVolumes:
    - type: secret
      name: vault-tls
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app.kubernetes.io/name: vault
              app.kubernetes.io/instance: guardrails-vault
              component: server
          topologyKey: kubernetes.io/hostname
```

Kubernetes operating notes:

- Run at least three schedulable nodes for the required anti-affinity rule, or relax anti-affinity in smaller non-production clusters.
- Initialize Vault once after the StatefulSet is healthy; the `retry_join` stanzas form the Raft cluster as peers become unsealed.
- Prefer auto-unseal through a cloud KMS in production; otherwise keep manual unseal keys split across operators.
- The Vault TLS certificate SANs must cover the `retry_join` DNS names and `leader_tls_servername`; otherwise Raft peer joins can fail TLS validation.
- The current Vault client uses a Vault token header. Use Vault Agent Injector to mint and refresh that token from Kubernetes auth, or use CSI/file/env injection for concrete secrets instead of the token-header client path.
- Bind application pods through Kubernetes auth roles scoped to their service accounts and namespaces when that bootstrap layer is in place.
- Size PVCs for audit volume and Raft snapshots; monitor disk pressure and snapshot age.
- Use NetworkPolicies so only pods that perform Vault bootstrap or secret retrieval can reach Vault, such as guardrail service, broker, reviewer, connector, or signer sidecars. Keep the agent sandbox excluded.

## Cloud-Managed Runtime

- Cloud-hosted Vault/HCP or cloud secret manager adapter.
- Managed container runtime (ECS, Cloud Run, etc.).
- Cloud-native network controls and security groups.
- Cloud-managed database or persistent storage for audit.

### HCP Vault setup

1. Create an HCP Vault cluster in the same region as the managed runtime.
2. Peer or privately connect the runtime network to the HCP Vault network; do not expose Vault to public agent egress.
3. Enable a runtime authentication method that matches the platform identity model, then use Vault Agent or the platform secret-injection layer to provide short-lived Vault tokens to components.
4. Create policies that separate reviewer, guardrail service, broker, connector, and signer secret access.
5. Store Binance, RPC, and reviewer provider secrets under distinct paths. Keep wallet private keys in KMS/HSM/MPC backends; store only references or signer configuration in Vault unless a dedicated signer component is explicitly designed to read Vault-held key material.

Terraform sketch:

```hcl
resource "hcp_vault_cluster" "guardrails" {
  cluster_id = "guardrails-prod"
  hvn_id     = hcp_hvn.guardrails.hvn_id
  tier       = var.hcp_vault_tier
}

resource "vault_policy" "broker" {
  name = "guardrails-broker"

  policy = <<EOT
path "kv/data/binance/*" {
  capabilities = ["read"]
}

path "kv/data/broker/*" {
  capabilities = ["read"]
}
EOT
}

resource "vault_policy" "signer" {
  name = "guardrails-signer"

  policy = <<EOT
path "kv/data/signer/config/*" {
  capabilities = ["read"]
}
EOT
}
```

Set `var.hcp_vault_tier` to the tier that matches the production SLA, throughput, and availability target. The signer policy is for signer configuration or KMS/HSM/MPC references. Do not grant the broker access to wallet private-key material.

IAM binding pattern:

- Assign each runtime service a distinct cloud identity.
- Bind that identity to exactly one Vault role.
- Scope the Vault role to the minimum secret paths required by that component.
- Rotate cloud identity credentials through the platform identity provider rather than static long-lived tokens.

## Vault Deployment Roadmap

| Stage | Vault Mode | Use Case |
|-------|-----------|----------|
| Local dev | Dev server | Development and tests only |
| Single VPS | Single-node integrated storage | First production deployment |
| Kubernetes | Helm with HA integrated Raft | Scalable production |
| Cloud | HCP Vault or cloud secret manager | Cloud-native production |

A guardrail enforces HTTPS Vault addresses for `canary_live` and `production`; runtime bootstrap must still verify that production Vault is not running in dev mode.

## OPA Distribution

| Environment | Binary/Image | Pinned Version |
|------------|-------------|----------------|
| CI | `opa_linux_amd64_static` | v1.16.1 (checksum verified) |
| Local Docker | `openpolicyagent/opa:1.16.1-static` | Pinned by image digest |

Upgrades require explicit version bump with updated checksums.
