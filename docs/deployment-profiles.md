# Deployment Profiles

## Overview

The framework supports multiple deployment profiles. Each profile defines how components are deployed, how secrets are managed, and what network controls are enforced.

## Local Docker (Development)

- Docker Compose starts Guardrail HTTP, the paper execution broker, and OPA. The optional `agent` profile provides a JSON Lines intent-submission process; the `dev` profile adds dev Vault.
- `deploy/docker/Dockerfile.service`, `Dockerfile.broker`, and `Dockerfile.agent` run compiled Node entrypoints as non-root users. Agent has only `GUARDRAIL_URL`, a read-only filesystem, and an internal network shared with Guardrail—not the broker or OPA networks. A direct-LLM egress proxy is not included.
- Published Guardrail (3000), broker (3001), OPA (8181), and optional Vault (8200) ports bind to `127.0.0.1`. Do not publish the unauthenticated development HTTP APIs on a public interface.
- OPA uses the pinned `openpolicyagent/opa:1.16.1-static` image. Reviewer uses the existing OpenAI provider and requires `OPENAI_API_KEY`; an absent key is a startup configuration error, not an automatic approval.
- Broker's standalone entrypoint deliberately supports `dev` and `paper` only, using `PaperExecutionConnector`. It refuses other profiles instead of presenting simulated trades as real execution. CEX/signing connectors remain available through the in-process API.
- Guardrail and broker have separate audit databases and external hash anchors. Each audit chain must have exactly one writer. Non-dev profiles require strong decision/audit secrets and hash anchors; no CEX or wallet keys are needed for simulated execution.

### Start locally

After `pnpm install`, `pnpm build`, and copying `env.example` to `.env`, configure the reviewer key and a trusted risk snapshot producer:

```sh
docker compose up -d opa
pnpm start:service                 # terminal 1; loads .env
pnpm start:broker                  # terminal 2; loads .env
curl -i http://127.0.0.1:3000/health

# Separate terminal; the agent does NOT load .env or receive signing/reviewer secrets.
GUARDRAIL_URL=http://127.0.0.1:3000 pnpm --silent start:agent < intents.jsonl
```

For containers, use `docker compose up --build -d guardrail broker`, then `docker compose run --rm -T agent < intents.jsonl`. Compose supplies only the required environment variables to each process. `SIGINT`/`SIGTERM` stop the HTTP listener, let in-flight requests finish, and close the audit database. Configuration/listen failures exit nonzero.

The service factory is `createGuardrailServer(service)` in `@guardrails/service`; it returns an unbound Node `http.Server` and never listens on import. `packages/runtime` assembles the existing OPA evaluator, OpenAI reviewer, risk engine, audit writer, broker, kill switch, and durable broker idempotency store.

### HTTP contract

| Endpoint | Request | Response |
|----------|---------|----------|
| Guardrail `GET /health` | No body | `service.health()`: 200 for `ok`, 503 for `degraded`; `opaHealthy` describes OPA reachability, not readiness of every external dependency |
| Guardrail `POST /evaluate` | Raw `TradingIntent` JSON, `Content-Type: application/json` | 200 with `GuardrailDecision`; policy/risk denials are decisions, not HTTP transport failures |
| Broker `GET /health` | No body | 200 with `status: ok`, `executionMode: paper` after successful dependency construction |
| Broker `POST /execute` | Signed decision fields plus the original `intent` | 200 with `BrokerExecutionResult`; the broker still verifies the HMAC, age, environment, kill switch, approval state, and idempotency before execution |

```sh
curl -i http://127.0.0.1:3000/evaluate \
  -H 'Content-Type: application/json' -H 'x-correlation-id: strategy-order-42' \
  --data-binary @intent.json
```

Validation failures return JSON: 400 for malformed JSON/schema/correlation IDs, 413 for a body over 1 MiB, 415 for an unsupported media type, 404 for unknown routes, and 405 with `Allow` for wrong methods. Internal failures return a generic 500 without exception details or secrets.

`x-correlation-id` accepts 1–128 characters from `[A-Za-z0-9._:-]`; omission generates a UUID. Responses echo the HTTP request ID, including application errors. Evaluation carries it into audit events and the signed decision. **Cached `needs_human` decisions retain their original body `correlationId`, `approvalId`, and token** to preserve the human-approval binding; the response header identifies the new HTTP request. Broker never replaces a signed decision's ID with its transport request ID.

For `/execute`, send `{intentId, correlationId, outcome, decidedAt, decisionToken, approvalId?, intent}` from the decision and original intent. Never generate tokens in the agent. `/evaluate` does not automatically execute. Human-approval resolution is not exposed over HTTP; process-local approval stores are not shared between standalone processes, so the broker rejects `needs_human` requests without an approved record. Use the existing in-process approval integration for that workflow.

The Agent entrypoint consumes raw intents, one JSON object per line, and prints one decision or `{error, message, correlationId?}` per nonblank line. It continues after invalid JSON/schema or failed HTTP requests and exits 1 if any submission failed; a policy denial is a successful submission, not a transport error. Requests time out after 30 seconds. EOF exits normally. This is an intent transport, not an autonomous strategy/LLM loop, and it never calls `/execute`.

### Runtime configuration and risk data

`GUARDRAIL_HOST`/`GUARDRAIL_PORT` default to `127.0.0.1:3000`; `BROKER_HOST`/`BROKER_PORT` default to `127.0.0.1:3001`. Images explicitly bind to `0.0.0.0` inside their private networks. `OPA_URL`, `REVIEWER_PROVIDER=openai`, `REVIEWER_MODEL`, `OPENAI_API_KEY`, `GUARDRAIL_ENV`, `GUARDRAIL_DECISION_SECRET`, and `APPROVAL_TIMEOUT_SECONDS` configure evaluation. Service and broker must use the same environment and decision secret.

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
