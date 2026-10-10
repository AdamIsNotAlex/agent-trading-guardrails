# Live Trading Safety

## Progression Path

Live trading is only enabled after progressive validation:

```
dev → paper → testnet → canary_live → production
```

Each stage must pass before advancing to the next. `production` is a reserved/planned profile today: the broker currently rejects production execution, while `canary_live` can execute only when explicitly enabled and kept within tight limits.

## Canary-Live Default Limits

| Market | Max Per Order | Max Per Day |
|--------|--------------|-------------|
| Binance spot | USD 10 | USD 50 |
| Binance USD-M futures | USD 5 | USD 25 |

USD-M futures default max leverage: 1x in canary-live. Higher leverage requires explicit policy change and human approval.

All limits are configuration defaults, not hardcoded constants.

## Prerequisites for Live Mode

Operator checklist before enabling canary-live (the dependency and credential gates below are enforced in code):

- [ ] Explicit configuration enables live mode (not enabled by default).
- [ ] Binance trading key reports `enableWithdrawals: false` through signed SAPI permissions lookup.
- [ ] `BINANCE_IP_ALLOWLIST` contains explicit, unique IP literals and the key reports `ipRestrict: true`.
- [ ] Audit storage accepts a probe event whose readback, HMAC chain head, and external hash anchor verify.
- [ ] Kill switch is initialized, reachable, and inactive at every applicable scope; unknown state is not treated as inactive.
- [ ] An explicit approval database is configured and passes an immediate transactional write/read/delete probe.
- [ ] Human approval is required unless policy explicitly allows no-human low-risk trades.
- [ ] Dedicated account/product, exhaustive history symbols, supported fee currencies, and reconciled
  Spot cost basis meet the [Binance data contract](deployment-profiles.md#binance-rest-and-exchange-backed-risk).
- [ ] `BROKER_CONNECTOR=binance`, `BINANCE_TESTNET=false`, and `BROKER_CANARY_LIVE_ENABLED=true`
  are explicitly configured only after testnet verification; default Compose remains paper-only.

`LiveModePreflightCheck` runs on canary execution attempts and broker previews, not just once at startup.
Its approval probe leaves no operator approval request. Audit probes intentionally append
`broker.preflight` events. A successful `/health` response alone is **not** canary readiness.
Kill state is checked again after awaited broker revalidation and immediately before connector side effects.

The Broker queries `GET https://api.binance.com/sapi/v1/account/apiRestrictions` for mainnet keys,
including USD-M futures keys, on each connector revalidation. Missing/malformed permissions or a failed
request block execution. Testnet never sends its credentials to mainnet SAPI. Required reading and
product-specific trading permissions must also be enabled.
The [official response model](https://github.com/binance/binance-connector-js/blob/master/clients/wallet/src/rest-api/types/get-api-key-permission-response.ts)
contains permission flags, **not the IP entries**: operators must confirm that the configured list
matches the Binance key's actual allowed egress addresses. A local list alone is never sufficient.

## First Live Trade Protocol

1. **Dry-run report** — Run the original pipeline: validate → reviewer → dynamic risk → policy →
   broker preflight/revalidation. Risk precedes policy because policy consumes the acquired risk facts.
   Neither service nor Broker executes an order, creates an operator approval, consumes approval, or
   reserves an execution idempotency key during this preview.
2. **Operator review and normal evaluation** — Inspect the report, then call normal `/evaluate` for
   the same intent. If it returns `needs_human`, approve that real request with the operator CLI.
   A preview has no approval ID and its signed decision cannot be promoted to an executable decision.
3. **Execute with receipt** — Every new canary `cex.place_order` requires both the normal signed
   decision and the successful report's `broker.authorization` as `dryRunAuthorization`.
   This receipt is bound to the full intent and expires after five minutes by default
   (`BrokerConfig.decisionMaxAgeMs` overrides this window when embedding the library).
   Changing any intent field requires a new preview. The receipt never waives current preflight,
   connector, kill-switch, or human-approval checks. Cancellation/status requests do not require it.
4. **Reconcile** — After a live Spot or USD-M order is accepted, query its status once using the bound
   account/product, symbol, and returned order ID. Compare identities, legal status progression,
   filled quantity, and the approved price limit; preserve both the acknowledgment and observation.
5. **Audit and replay** — `BrokerExecutionResult.reconciliation` and the `broker.executed` audit event
   carry `matched`, `discrepancy`, or `unavailable`, a check timestamp, and discrepancy details.
   Failed status lookup does not erase an accepted order or turn it into a retryable submission.
   Durable idempotency retains the result and pending terminal audit across restart.

### Operator commands

After configuring and starting the trusted service and Broker:

```sh
export GUARDRAIL_URL=http://127.0.0.1:3000
export BROKER_URL=http://127.0.0.1:3001
umask 077
pnpm --silent start:canary-dry-run < intent.json > dry-run.json
jq -e '.status != "blocked"' dry-run.json
```

The CLI reads one canary CEX order intent from stdin and writes one JSON report. `status` is
`ready`, `needs_human`, or `blocked`; blocked reports exit nonzero. The report includes the full
intent, all five stage outcomes, reviewer verdict, risk checks, policy reasons, and broker checks.
`needs_human` is readiness for operator approval, not permission to submit immediately.

After reviewing the report, obtain the normal decision:

```sh
curl -fsS "$GUARDRAIL_URL/evaluate" -H 'Content-Type: application/json' \
  --data-binary @intent.json > decision.json
jq -e '.outcome == "allow" or .outcome == "needs_human"' decision.json
```

If required, resolve that decision's approval through the
[operator approval workflow](deployment-profiles.md#cross-process-human-approval). Then submit without
rewriting its outcome, correlation ID, or token:

```sh
jq -s '.[0] + {intent: .[1], dryRunAuthorization: .[2].broker.authorization}' \
  decision.json intent.json dry-run.json > execution.json
curl -fsS "$BROKER_URL/execute" -H 'Content-Type: application/json' \
  --data-binary @execution.json
```

Keep decisions and reports in operator-only storage; never inject `BROKER_URL` or credentials into
Agent. Re-run the preview if its receipt expires. A cached accepted execution can be replayed with
the same valid normal decision without another receipt and without another order submission.

`matched` is a consistent **point-in-time** observation, not a guarantee of final settlement.
An unfilled limit order can remain `NEW`; additional fills can legitimately advance it to
`PARTIALLY_FILLED` or `FILLED`. For `discrepancy`/`unavailable`, investigate the preserved order ID
and use guarded status queries; do not retry the trade with a new idempotency key.

## Kill Switch

The kill switch immediately halts all execution. It can be activated at multiple scopes:

| Scope | Effect |
|-------|--------|
| Global | All execution halted |
| Per-agent | Specific agent halted |
| Per-account | Specific CEX account/subaccount halted |
| Per-exchange | All activity on specific exchange halted |
| Per-chain | All onchain activity on specific chain halted |

The standalone runtime initializes an in-memory backend. `BROKER_KILL_SWITCH=true` starts it in
global-stop state; changing that environment setting requires a restart. Embedded backends must
return a real boolean from `isActive(scope)` or throw on an unavailable controller.

## Rollback

If live trading reveals issues:

1. Activate kill switch at the appropriate scope.
2. Review audit log for the decision chain.
3. Cancel any open orders through the broker.
4. Revert to paper/testnet mode.
5. Investigate and fix before re-enabling.
