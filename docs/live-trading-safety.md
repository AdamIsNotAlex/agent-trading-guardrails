# Live Trading Safety

## Progression Path

Live trading is only enabled after progressive validation:

```
dev → paper → testnet → canary_live → production
```

Each stage must pass before advancing to the next.

## Canary-Live Default Limits

| Market | Max Per Order | Max Per Day |
|--------|--------------|-------------|
| Binance spot | USD 10 | USD 50 |
| Binance USD-M futures | USD 5 | USD 25 |

USD-M futures default max leverage: 1x in canary-live. Higher leverage requires explicit policy change and human approval.

All limits are configuration defaults, not hardcoded constants.

## Prerequisites for Live Mode

Before any live execution is permitted:

- [ ] Explicit configuration enables live mode (not enabled by default).
- [ ] Binance API key has no-withdrawal permission.
- [ ] Binance API key has IP allowlist configured.
- [ ] Audit log is enabled and healthy.
- [ ] Kill switch is enabled and reachable.
- [ ] Human approval is required unless policy explicitly allows no-human low-risk trades.

## First Live Trade Protocol

1. **Dry-run report** — Generate a full report of what would execute, including policy evaluation, risk checks, and broker revalidation, without actually executing.
2. **Human review** — Operator reviews the dry-run report and approves.
3. **Execute** — Broker executes the action.
4. **Post-trade reconciliation** — Compare expected outcome with actual CEX/chain state.
5. **Audit** — Full decision chain recorded in audit log.

## Kill Switch

The kill switch immediately halts all execution. It can be activated at multiple scopes:

| Scope | Effect |
|-------|--------|
| Global | All execution halted |
| Per-agent | Specific agent halted |
| Per-account | Specific CEX account/subaccount halted |
| Per-exchange | All activity on specific exchange halted |
| Per-chain | All onchain activity on specific chain halted |

## Rollback

If live trading reveals issues:

1. Activate kill switch at the appropriate scope.
2. Review audit log for the decision chain.
3. Cancel any open orders through the broker.
4. Revert to paper/testnet mode.
5. Investigate and fix before re-enabling.
