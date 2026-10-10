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
| Guardrail `POST /dry-run` | Raw `TradingIntent` JSON | Fresh `GuardrailDecision` with `dryRun: true`; purpose-separated signature, no live decision cache or human approval creation |
| Broker `GET /health` | No body | 200 with `status: ok` and configured `executionMode: paper`, `binance-testnet`, or `binance-live`; not proof of exchange credentials or readiness |
| Broker `POST /execute` | Normal signed decision plus original `intent`; new canary orders also require `dryRunAuthorization` | `BrokerExecutionResult`; current preflight, HMAC, environment, kill switch, approval state, idempotency, and connector checks remain authoritative |
| Broker `POST /dry-run` | Signed preview fields (`dryRun: true`) plus original `intent` | `BrokerDryRunResult` with preflight/revalidation checks and a fresh intent-bound authorization receipt only on success; never submits |
| Signer `GET /health` (execution network only) | No body | 200 with `mode: offline-sepolia`, `chainId: 11155111`, and the persisted key's public address |
| Signer `POST /sign` (execution network only) | `SigningRequest`: original allow approval plus bounded EIP-1559 envelope | 200 with `OfflineSignature`: signed bytes and their hash, **not a broadcast/execution result**; 403 for failed authorization/caps and 409 for reused/conflicting/reserved signing state |

```sh
curl -i http://127.0.0.1:3000/evaluate \
  -H 'Content-Type: application/json' -H 'x-correlation-id: strategy-order-42' \
  --data-binary @intent.json
```

Validation failures return JSON: 400 for malformed JSON/schema/correlation IDs, 413 for a body over 1 MiB, 415 for an unsupported media type, 404 for unknown routes, and 405 with `Allow` for wrong methods. Internal failures return a generic 500 without exception details or secrets.

`x-correlation-id` accepts 1–128 characters from `[A-Za-z0-9._:-]`; omission generates a UUID. Responses echo the HTTP request ID, including application errors. Evaluation carries it into audit events and the signed decision. **Cached `needs_human` decisions retain their original body `correlationId`, `approvalId`, and token** to preserve the human-approval binding; the response header identifies the new HTTP request. Broker never replaces a signed decision's ID with its transport request ID.

For `/execute`, send `{intentId, correlationId, outcome, decidedAt, decisionToken, approvalId?, intent}` from the decision and original intent. Never generate tokens in the agent. `/evaluate` does not automatically execute. Human-approval resolution is not exposed over HTTP; a trusted operator uses the standalone command below. After approval, submit the **original signed `needs_human` decision**, including its original correlation ID and approval ID, to Broker. Do not relabel it as `allow` or regenerate its token.

New canary orders add `dryRunAuthorization: {checkedAt, token}` from a successful broker preview.
The operator command `pnpm --silent start:canary-dry-run < intent.json` orchestrates both preview
endpoints and emits the complete report; `GUARDRAIL_URL` and operator-only `BROKER_URL` select the
trusted origins. A preview signature is not a normal execution approval, even if its `dryRun` field
is removed. See the [canary first-order procedure](live-trading-safety.md#first-live-trade-protocol).

The Agent entrypoint consumes raw intents, one JSON object per line, and prints one decision or `{error, message, correlationId?}` per nonblank line. It continues after invalid JSON/schema or failed HTTP requests and exits 1 if any submission failed; a policy denial is a successful submission, not a transport error. Requests time out after 30 seconds. EOF exits normally. This is an intent transport, not an autonomous strategy/LLM loop, and it never calls `/execute`.

### Cross-process human approval

Guardrail, Broker, and the operator command share `APPROVAL_DB_PATH` (default `./data/approvals.db`). Use the same absolute path when starting processes from different working directories, and a separate database for each deployment/environment. SQLite WAL requires a local filesystem shared by these processes, not an NFS-backed or cross-host database. Compose mounts `approvals-data` at `/app/approvals` in Guardrail and Broker only; Agent cannot access it.

After `pnpm build`, run these commands as a trusted operator:

```sh
pnpm start:approval -- list --state pending
pnpm start:approval -- show "$APPROVAL_ID"
pnpm start:approval -- approve "$APPROVAL_ID" --by operator-1
# Alternative decision: pnpm start:approval -- deny "$APPROVAL_ID" --by operator-1
pnpm start:approval -- watch

# --db overrides APPROVAL_DB_PATH for this invocation:
pnpm start:approval -- list --db /absolute/path/approvals.db

# Use Broker's operator audit chain consistently inside Compose:
docker compose exec -T broker node packages/runtime/dist/approval-main.js list --state pending
docker compose exec -T broker node packages/runtime/dist/approval-main.js approve "$APPROVAL_ID" --by operator-1
```

`list` prints complete approval IDs; `show` prints the persisted request and decision provenance. Commands exit 1 for invalid arguments, missing requests, expired/already-decided approvals, or storage/audit failures. `watch` refreshes every two seconds (`APPROVAL_WATCH_INTERVAL_MS` overrides the interval) and closes the database on SIGINT/SIGTERM. `--by` is an audit identity label, **not authentication**: protect filesystem/container access and never give Agent write access to approval state or operator audit secrets.

Pending, approved, denied, timed-out, and consumed records survive process restarts. Each decision and one-time consumption acquires a SQLite write transaction before checking state, so concurrent operators cannot overwrite a decision and only one Broker can consume an approval. Polling waits read the shared database rather than a cached object. The deadline is fixed at creation by `APPROVAL_TIMEOUT_SECONDS`; reading/watching or attempting a decision expires overdue pending requests. Expired approved records retain their decision provenance but cannot be consumed. Returned library objects are snapshots, not mutable storage handles; explicitly close injected `ApprovalStore` instances when their owner shuts down. Standalone runtimes and CLI reject in-memory databases; tests may explicitly use `:memory:`.

Operator decisions use a separate `APPROVAL_AUDIT_DB_PATH` (default `./data/approval-audit.db`) and `APPROVAL_AUDIT_HASH_ANCHOR_PATH` (default `./audit-anchor/approval/head.hash`). Never reuse a Guardrail/Broker audit database or anchor. Concurrent operator commands for one approval database must use the same operator audit database, anchor, and `AUDIT_HASH_SECRET`; do not reuse that chain for another approval database. The CLI opens a fresh audit writer inside the approval transaction, and an audit failure leaves the request pending. Non-development request environments enforce the existing audit secret/anchor requirements even when the CLI itself runs with development defaults.

`APPROVAL_ALLOWLIST_PATH` optionally enables the existing allowlist-onboarding file update; without it, onboarding approvals fail closed. This file is separate from the pending-request database and does not automatically reload OPA policy. Preserve approval state across upgrades: use SQLite's online backup facilities or stop all writers before backing up; copying only the main database during active WAL writes is not a consistent backup. The service images pin the shared-volume owner to UID/GID 999; existing volumes owned by a different UID need an operator-managed ownership migration, not world-writable permissions. Requests held only in the old in-memory Map cannot be recovered after that process exits; re-evaluate those intents to create durable requests.

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

`RISK_DATA_PROVIDER=file` is the default. `RISK_DATA_PATH` defaults to `./data/risk/risk-snapshot.json`. Compose fixes this backend and mounts the host `./data/risk` directory read-only into Guardrail. A trusted feed outside the agent must atomically replace this JSON file. Each evaluation reads one consistent snapshot and applies `DEFAULT_CANARY_LIVE_LIMITS`; missing, malformed, mismatched, future-dated, or stale facts fail closed. The runtime never substitutes intent prices for market data or synthesizes successful risk checks.

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

## OpenClaw and Hermes runtime plugins

The native plugins use remote `POST /evaluate`; neither runs `GuardrailService` in the framework
process. Verified hosts: **OpenClaw 2026.9.9** (Node 24.18.0) and **Hermes Agent 0.17.0**
(Python 3.11). OpenClaw's plugin API is experimental: pin the host and smoke-test upgrades.
The bridge/bundles require Node 22+; the OpenClaw host itself requires Node 24.16+ or 26.1+.

### Build portable artifacts

```sh
pnpm install
pnpm package:plugins
```

Outputs:

- `packages/agent-adapters/dist/plugins/openclaw/`: `package.json`, `openclaw.plugin.json`,
  and bundled `index.mjs`. The manifest declares tool ownership, optional-tool metadata,
  and a strict configuration schema. No workspace packages or host SDK copies are needed
  in the installed plugin.
- `packages/agent-adapters/dist/plugins/hermes/`: `plugin.yaml`, Python `__init__.py`,
  bundled `bridge.mjs`, and generated `tools.json`. Copy the **whole directory**, not only
  the Python entry point. No pip dependencies are required by this plugin.

Both artifacts derive parameter schemas from the existing intent schemas and exclude the
operator-bound `principal`, `environment`, `action`, and `resource` fields. Build output is
ignored by Git; rebuild after source/schema changes before installation.

### Install into OpenClaw

Pack the generated directory and install through the native managed package path:

```sh
npm pack ./packages/agent-adapters/dist/plugins/openclaw --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/guardrails-openclaw-trading-0.0.1.tgz \
  --force --no-enable --accept-capabilities
```

Review the artifact before accepting capabilities. `--force` acknowledges the local archive
outside ClawHub trust metadata and can replace an existing installation. The native plugin id
is **`trading-guardrails`**, not the npm package name `@guardrails/openclaw-trading`.

Merge this into the selected OpenClaw profile's `openclaw.json`; preserve unrelated settings:

```json
{
  "plugins": {
    "allow": ["trading-guardrails"],
    "entries": {
      "trading-guardrails": {
        "enabled": true,
        "config": {
          "guardrailUrl": "http://127.0.0.1:3000",
          "principal": "agent.openclaw.strategy-alpha",
          "environment": "paper",
          "timeoutMs": 30000
        }
      }
    }
  },
  "tools": { "allow": ["trading-guardrails"] }
}
```

The tools are optional: plugin enablement alone does not expose them to a model; the tool
allowlist must also permit them. This example deliberately selects only the guarded plugin.
Use an agent-scoped tool allowlist when sharing a Gateway, or separate profiles/processes for
different policy principals. Restart the Gateway after configuration changes, then inspect:

```sh
openclaw plugins inspect trading-guardrails --runtime --json
```

Expect `status: loaded`, five tool names, `optional: true`, and no missing dependencies or
registration diagnostics. This inspection proves registration, not Guardrail readiness.
OpenClaw's invocation `AbortSignal` is forwarded to the HTTP client, including pre-call cancellation.

### Install into Hermes

Hermes 0.17 uses the native directory-plugin loader and `ctx.register_tool(...)`. It does not
provide the newer `ctx.get_config()` API; this plugin intentionally uses an explicit, small
environment contract rather than importing or patching framework internals.

```sh
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins/trading-guardrails"
cp -a ./packages/agent-adapters/dist/plugins/hermes/. \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/trading-guardrails/"

export GUARDRAIL_URL=http://127.0.0.1:3000
export GUARDRAIL_PRINCIPAL=agent.hermes.strategy-beta
export GUARDRAIL_ENV=paper
export GUARDRAIL_TIMEOUT_MS=30000
# Optional when Node is not on PATH:
# export GUARDRAIL_NODE_BINARY=/absolute/path/to/node

hermes plugins enable trading-guardrails
hermes plugins list
hermes
```

For a service/gateway, inject the same variables into its service environment and restart it.
Do **not** source the repository's full `.env` into Hermes. The plugin binds configuration at
registration, declares its tools in `plugin.yaml`, and registers the `trading_guardrails` toolset.
Each invocation runs the packaged Node bridge with argv/stdin, never a shell; this reuses the
same TypeScript intent conversion and HTTP decision validation as OpenClaw. The child receives
only the Guardrail settings, PATH/platform temp variables, and optional `NODE_EXTRA_CA_CERTS`,
not model/exchange/signing secrets or `NODE_OPTIONS`. The HTTP deadline defaults to 30 seconds
and is configurable from 1–60000ms; Python kills a stalled child after that deadline plus five
seconds. There are no persistent child workers or automatic retries.

### Tool results and identity boundary

| Native tool | Submitted intent action |
|-------------|-------------------------|
| `guardrails_propose_order` | `cex.place_order` |
| `guardrails_cancel_order` | `cex.cancel_order` |
| `guardrails_get_order_status` | `cex.get_order_status` |
| `guardrails_simulate_transaction` | `onchain.simulate_transaction` |
| `guardrails_request_signature` | `onchain.request_signature` |

Tool parameter schemas require the intent's business fields, rationale/evidence, a UUID
`intentId`, ISO `requestedAt`, and `idempotencyKey`. Keep these identifiers and all business
fields unchanged when repeating a submission. Do not generate new envelope timestamps for a
retry of the same approved action. The embedding adapters still generate omitted UUID/time
fields for callers that are not using the framework's advertised schema.

`success: true`/`outcome: allow` means **authorized**, not filled/canceled/simulated/signed.
`needs_human` has `success: false` and includes the approval id and original signed decision
binding. Preserve the body correlation id/token even if the HTTP response header identifies
a different retry request. A trusted operator/execution process handles approval and Broker
submission; neither plugin ever calls `/execute` or `/sign`. In particular, a simulation intent
id is not a simulation result id. The Hermes example waits for real simulation evidence before
requesting signature authorization.

Unavailable services, timeouts, HTTP errors/redirects, malformed decisions, unsigned allows,
and invalid tool arguments return fail-closed results without approval tokens. Native framework
settings select the endpoint and identity; tool arguments cannot rebind them. These settings
are **not authentication**: protect configuration from the agent and use a trusted authenticated
gateway to bind callers to policy identities outside local development. The standalone HTTP
service remains unauthenticated. Do not expose it to an untrusted network.

Installing a plugin does not sandbox its host or disable other terminal/network tools. Keep
exchange credentials, signer keys, decision secrets, and Broker connectivity outside the agent
process. Apply the existing network/container controls to the actual framework host; the default
Compose Agent remains the JSONL entrypoint, not an automatically installed OpenClaw/Hermes app.

For direct TypeScript embedding, replace the old in-process-service constructor argument:

```typescript
import { GuardrailEvaluateClient, OpenClawAdapter } from "@guardrails/agent-adapters";

const client = new GuardrailEvaluateClient({ baseUrl: "http://127.0.0.1:3000" });
const adapter = new OpenClawAdapter(client, "agent.openclaw.strategy-alpha", "paper");
// HermesAgentAdapter has the same remote-client constructor contract.
```

Host contracts: [OpenClaw native plugins](https://docs.openclaw.ai/plugins/building-plugins),
[OpenClaw manifests](https://docs.openclaw.ai/plugins/manifest), and
[Hermes native plugins](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins).

## Binance REST and exchange-backed risk

The standalone runtime supports `RISK_DATA_PROVIDER=binance` and `BROKER_CONNECTOR=binance`.
`BinanceRestClient` implements the existing connector interface; `BinanceRiskDataProvider`
implements `RiskDataProvider` in `@guardrails/binance-connector`. Guardrail constructs a new
provider for every evaluation, pinning portfolio/history facts within that evaluation only.
Do the same when embedding the library; do not share a provider instance across decisions.

Use a **dedicated Binance account/subaccount and one product per deployment**. The local
`BINANCE_ACCOUNT` alias binds to its API key; it is not sent as an exchange account selector.
Spot and USD-M have distinct order namespaces. `BINANCE_ACCOUNT_MODE` fixes prices, account
data, cancellation, and status queries to the selected product. Deploy separate runtimes,
aliases, and state directories for separate accounts/products. Use read-only USER_DATA keys
for Guardrail and separate no-withdrawal trading keys for Broker, for the same account.

After `pnpm install && pnpm build`, configure the trusted service/Broker environments:

```dotenv
GUARDRAIL_ENV=testnet
RISK_DATA_PROVIDER=binance
BROKER_CONNECTOR=binance
BINANCE_TESTNET=true
BINANCE_ACCOUNT=subaccount-1
BINANCE_ACCOUNT_MODE=spot
BINANCE_SYMBOLS=ETH-USDC
BINANCE_HISTORY_SYMBOLS=ETH-USDC
BINANCE_MAX_FUTURES_LEVERAGE=1
BINANCE_API_KEY_FILE=/run/secrets/binance-api-key
BINANCE_API_SECRET_FILE=/run/secrets/binance-api-secret
BROKER_CANARY_LIVE_ENABLED=false
```

Set the existing non-development decision/audit secrets and separate audit anchors too;
then run `pnpm start:service` and `pnpm start:broker`. `*_FILE` reads a secret-manager-injected
UTF-8 credential at startup; alternatively use `BINANCE_API_KEY`/`BINANCE_API_SECRET` in the
trusted process environment, never both forms for a credential. Rotation requires restart.
No direct Vault lookup is implied by these settings. Agent must receive only its Guardrail URL,
never these credentials or a copy of the service `.env`.

For USD-M use `BINANCE_ACCOUNT_MODE=usdm_futures` and the appropriate `BASE-USDT`/`BASE-USDC`
symbols. Configure **one-way positions and isolated margin** at Binance beforehand. The client
verifies margin mode and the requested leverage; it sets leverage before submitting the order
but never silently changes cross margin or hedge mode. Canary mainnet additionally requires
`GUARDRAIL_ENV=canary_live`, `BINANCE_TESTNET=false`, `BROKER_CANARY_LIVE_ENABLED=true`, and
`BINANCE_IP_ALLOWLIST` containing the trusted process's comma-separated egress IP literals.
Paper/dev cannot select real execution; testnet/mainnet mismatches fail startup. `production`
execution remains unsupported. Policy, approvals, kill switch, signed decisions, and durable
broker idempotency still apply; none are bypassed by selecting this connector.

Every mainnet Binance runtime requires the IP list at startup (including the read-only risk runtime).
Broker additionally verifies its key's withdrawal/IP restriction flags from mainnet SAPI, even when
trading USD-M on `fapi.binance.com`. Testnet does not query this mainnet permissions endpoint.
Canary execution also probes audit write/readback/anchor integrity and explicitly configured approval
storage, checks kill-switch reachability, and requires a fresh full-pipeline preview receipt for new
orders. After submission, `reconciliation` retains both the accepted order and queried state in the
response and durable audit. Follow the [live-trading protocol and limitations](live-trading-safety.md).

**Data and accounting contract:**

- Symbols are canonical `BASE-USDT`/`BASE-USDC`. Amounts ending in `Usd` are USD-equivalent
  assuming those stablecoins remain at par; there is no external USD/depeg oracle. Spot permits
  only one quote pair per base asset to keep reconstructed cost basis unambiguous.
- `BINANCE_SYMBOLS` is the new-order allowlist. `BINANCE_HISTORY_SYMBOLS` must be the exhaustive
  lifetime trading universe, including symbols disabled for new orders; omission defaults to
  `BINANCE_SYMBOLS`. Never omit old symbols to reduce reported turnover/loss. Do not trade other
  symbols, other products, or externally alter inventory in this dedicated account. Spot REST
  history is symbol-scoped: the adapter cannot discover a fully closed, unconfigured symbol.
  Uncovered active assets/positions are rejected rather than omitted.
- Spot ticker prices come from `/api/v3/ticker/price`; its timestamp is the request-start
  observation time because the response has no event timestamp. USD-M quotes use
  `/fapi/v2/ticker/price` and its exchange timestamp. Keep the host clock synchronized.
  Spot account reads include free **and locked** balances. USD-M uses `/fapi/v3/account` and
  `/fapi/v2/positionRisk`; short quantities/notionals retain their signs, without multiplying
  exposure by leverage.
- Daily boundaries are UTC. Executed turnover sums fill `quoteQty`, not submitted quantity
  or leverage-adjusted notional. Daily order count includes unfilled/canceled orders from
  `allOrders`; split fills do not multiply order count. Latest-order queries include prior
  days within the exchange's retained history; a successful empty query means no retained
  recent order, not proof of no lifetime orders. Exchange history is not a reservation for
  concurrent approvals or future fills of already-open orders.
- Spot reconstructs weighted-average acquisition cost from paginated `myTrades` starting at
  `fromId=0`. Buy commissions are capitalized; sell commissions reduce proceeds or consume
  extra base inventory. Daily realized loss sums losing sells without offsetting profitable
  sells. Reconstructed inventory must reconcile to actual balances. Deposits/withdrawals,
  unavailable historical basis, or incomplete history reject evaluation—not zero loss.
  Only base-asset/USDT/USDC fees are valued; disable BNB fee payment for this account.
- USD-M reads paginated `userTrades`, `allOrders`, and `income`. Loss sums negative non-transfer
  income, including realized PnL, commissions, funding, and liquidation costs; profits do not
  restore the daily loss budget. Trade commissions are not counted twice. Unvalued income
  currencies reject evaluation. Old futures days outside complete canceled-order retention
  are rejected.
- Full pages are followed using ID/page cursors or split inclusive time windows. A saturated
  single millisecond, non-advancing cursor, malformed response, permission/rate-limit failure,
  timeout, collection older than 30 seconds, or UTC rollover fails closed. There is no stale
  cache/zero-data fallback. A busy account or long backfill may therefore deny evaluation.
  REST observations are not an atomic exchange snapshot; racing activity can cause safe denials.

Endpoints are fixed to `testnet.binance.vision` / `demo-fapi.binance.com` or `api.binance.com` /
`fapi.binance.com`; there is no configurable credential-forwarding URL. Signed requests use
HMAC-SHA256, `X-MBX-APIKEY`, millisecond timestamps, a default 5000ms receive window and 10-second
HTTP timeout, with redirects disabled. Errors exclude credentials, signed URLs, and exchange
message bodies. There are **no automatic write retries**: timeouts/5xx can mean an order was
accepted. Preserve the broker reservation and reconcile the deterministic client order ID
before any operator recovery; never delete idempotency state and blindly resubmit.

Default Compose explicitly remains `file` + `paper`, with no exchange egress. These standalone
settings do not punch a hole in the Agent sandbox or turn that local stack into a live profile.
For a real deployment, provision tightly allowlisted exchange TLS egress only for trusted
Guardrail/Broker processes and keep their HTTP interfaces behind authenticated access control.

API references: [Binance signing and timing security](https://developers.binance.com/en/docs/products/spot/rest-api#request-security),
[official Spot REST specification](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md),
and [official USD-M endpoint definitions](https://github.com/binance/binance-futures-connector-python/blob/main/binance/um_futures/account.py).

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
