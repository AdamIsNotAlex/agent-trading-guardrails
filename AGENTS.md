# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript pnpm workspace for agent trading guardrails. Source code lives in
`packages/*/src`, with each package owning a focused boundary such as `guardrail-service`,
`broker`, `risk-engine`, `reviewer`, `secrets`, `audit`, and chain or exchange connectors.
Tests are colocated beside source as `*.test.ts`. JSON schemas are in
`packages/schemas/json-schema`, Rego policy rules and policy tests are in `packages/policy/src`,
deployment assets are in `deploy/`, and design/security documentation is in `docs/`.

## Build, Test, and Development Commands

- `corepack enable`: enable the pnpm version declared by the repo.
- `pnpm install`: install workspace dependencies.
- `pnpm build`: run `tsc -b` across the monorepo.
- `pnpm typecheck`: typecheck all TypeScript projects.
- `pnpm test`: run unit tests with Vitest.
- `pnpm test:watch`: run Vitest in watch mode during development.
- `pnpm test:coverage`: run Vitest with V8 coverage.
- `pnpm test:integration`: run `*.integration.test.ts` using the integration config.
- `pnpm lint`: run Biome checks.
- `pnpm lint:fix` or `pnpm format`: apply safe Biome fixes/formatting.
- `pnpm run ci`: run lint, typecheck, unit tests, and integration tests before opening a PR.

## Coding Style & Naming Conventions

Use TypeScript with ESM-style imports/exports. Biome enforces 2-space indentation, double quotes,
semicolons, trailing commas, and a 100-character line width. Keep module names kebab-case
(`paper-connector.ts`) and exported types/classes descriptive (`PolicyInput`, `AuditWriter`).
Prefer explicit interfaces at package boundaries and avoid non-null assertions unless justified.

## Testing Guidelines

The unit configuration discovers `packages/*/src/**/*.test.ts` but excludes `*.integration.test.ts`;
the integration configuration discovers `packages/*/src/**/*.integration.test.ts` only.
Both configurations fail when no test files are discovered.

Place tests next to the code they exercise and name them
after the behavior or module, for example `broker.test.ts` or `connector.test.ts`. Add coverage when
changing policy decisions, signing/secrets behavior, execution paths, audit integrity, or risk
checks. Run `pnpm run ci` for broad validation.

## Commit & Pull Request Guidelines

Recent commits use short, imperative subjects such as `Add Phase 15 human approval system` and
`Fix CI test failures by using tsc -b for monorepo builds`. Keep subjects concise and describe the
observable change. PRs should include a brief summary, test results, linked issues or planning docs
when relevant, and screenshots or logs only for user-visible CLI/deployment behavior.

## Security & Configuration Tips

Never commit real API keys, wallet private keys, seed phrases, or production `.env` files. Start from
`env.example`, keep secrets outside the agent runtime, and preserve the architecture rule that
reviewer output is advisory while policy and broker boundaries remain authoritative.

## Lessons

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080`; urgent security patch overrides for
  newly released packages must also add matching `minimumReleaseAgeExclude` entries, including
  package-specific binary packages such as `@esbuild/*` when overriding `esbuild`.
- `vitest.config.ts` excludes `**/*.integration.test.ts` while preserving `configDefaults.exclude`.
  Both configs fail on empty discovery; `pnpm run ci` runs unit and integration suites separately.
  On a clean checkout, run `pnpm build` before either suite because workspace package exports
  target `dist/`; the GitHub Actions workflow already preserves that order.
- The real-Rego transform integration is conditional on `opa` being on `PATH`; without it, the
  suite is skipped even with `passWithNoTests: false`. The separate GitHub Actions
  `opa-policy-test` job does not install OPA in the integration-test job.
- Standalone Guardrail and broker audit chains need separate SQLite databases and hash anchors:
  `AuditWriter` retains its chain head in memory, so sharing a chain across processes is unsafe.
- HTTP response `x-correlation-id` identifies the current request. A cached `needs_human`
  decision retains its original body correlation ID and token to preserve the approval binding;
  clients must not rewrite the signed decision to match the transport header.
- `transformOpaOutput` validates more than the `PolicyOutput` schema: every allow reason's
  `rule` must appear in `matchedAllowRules`. HTTP fixtures must preserve that relationship
  or the real service correctly converts them into fail-closed denials.
- `pnpm run ci` does not run dependency audits. Verify both `pnpm audit --audit-level=high --prod`
  and `pnpm audit --audit-level=high` after dependency fixes: development-only paths can fail
  `CI / security` even when the production audit passes.
- Docker's embedded DNS uses OUTPUT DNAT. Block `127.0.0.11` in a separate raw-priority
  nftables hook; evaluate `ct state established,related` in the later filter hook, after
  conntrack. Replace only the sandbox-owned table, not Docker's namespace rules.
- Internal Docker bridges omit a default route, so public/metadata `connect()` attempts can
  fail before OUTPUT/NFLOG. The Agent helper installs a bridge-gateway route only after
  lockdown, retaining both default-deny nftables and the internal bridge while logging drops.
- Debian dnsmasq 2.90 calls `setgroups` even with `user=root`/`group=root`: its trusted helper
  needs `SETGID` as well as `NET_ADMIN`/`NET_BIND_SERVICE`; the Agent still drops every cap.
  NFLOG's proc entry may appear only after ulogd binds and the kernel autoloads the module.
- Read-only Debian Nginx needs explicit `/tmp` paths for proxy, client-body, FastCGI, uWSGI,
  and SCGI temporary files, even when the latter protocols are unused. Read-only dev Vault
  runs as `vault` with `SKIP_CHOWN`, `SKIP_SETCAP`, and `-dev-no-store-token`.
- OpenAI SDK 6.36.0 reads `OPENAI_BASE_URL` when constructed with only `apiKey`. Reviewer
  runtime configuration now uses `REVIEWER_BASE_URL` and explicitly passes the SDK base URL;
  Compose fixes the common prefix to its private reviewer proxy without exposing keys to Agent.
- `viem` 2.48.8 signature recovery expects a concrete serialized transaction type (such as
  `TransactionSerializedEIP1559`), not generic `Hex`. Validate the response before narrowing;
  Node fetch JSON is `unknown` in the runtime's type environment.
- `ApprovalStore` defaults to shared SQLite via `APPROVAL_DB_PATH`; returned requests are detached
  snapshots. Tests explicitly select `:memory:` unless exercising persistence. Change expiry tests
  with the clock, not by mutating a returned request. Runtime owners must close their stores.
- Operator CLI audit callbacks run under the approval database's immediate write transaction and
  open a fresh writer per event. Keep that CLI chain separate from Guardrail/Broker audit chains;
  all CLI writers for a chain must share the same approval database lock.
- Binance REST clients bind one credential/account alias and one product; cancellation/status intents
  have no accountMode, so never infer Spot vs USD-M from overlapping symbol/order IDs.
- Binance risk providers are evaluation-scoped. Acquire all snapshots before computing risk-check
  time, and reuse one portfolio for freshness/exposure; a pre-fetch clock rejects fresh live data.
- Spot realized loss needs paginated lifetime fills and inventory reconciliation, not daily buys/sells
  alone. Futures `userTrades` cannot combine `fromId` with time bounds; split saturated inclusive
  windows without skipping equal-timestamp fills, and reject an unsplittable full millisecond.
- Exchange-controlled strings used with static `Record<string, true>` allowlists require `=== true`
  (or an own-property check); inherited names such as `constructor` must not classify as transfers
  or supported USD assets and silently erase reported loss.
- Native plugin artifacts are built by `pnpm package:plugins`; bundle workspace dependencies so
  OpenClaw's managed npm install and Hermes's copied plugin directory need no repository links.
- OpenClaw 2026.9.9 requires `contracts.tools`, optional-tool metadata, and explicit capability
  consent for local npm-pack installs. Configuration uses the manifest id, not the npm package name.
- Hermes 0.17.0 has `ctx.register_tool` but no `ctx.get_config`; the native plugin binds its small
  Guardrail environment contract at registration and forwards only allowed variables to Node.
- A guarded simulation tool returns authorization, not a simulation receipt. Never use its intent
  id as proof that simulation executed or as an invented simulation result for signing.
- Geth prestateTracer diffs are sparse: account fields present only in `pre` are unchanged
  while the account survives, but storage keys present only in `pre` were cleared. Unchanged
  contract bytecode in `pre` is not evidence of a code deletion.
- ERC-20 balance effects need audited mapping slots and pinned pre/post `balanceOf` probes;
  transfer logs alone do not attest balances. Built-in EVM simulation excludes gas fees,
  while Solana account snapshots include the fee-payer debit.
- Solana `minContextSlot` is a lower bound, not a pinned bank. Use finalized snapshots and
  require exact simulation/snapshot slot equality; validate Token-2022 mint extensions in
  both pre and post state, and observe program accounts as well as writable token accounts.
- The canonical Token-2022 program is `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`;
  the older fixture string ending in `BHN4VPgY6M` is not a valid public key.
- Canary previews bypass live decision caches/approval creation and use a separate HMAC purpose.
  Their broker receipt proves readiness, not human approval; normal decisions remain independently required.
- Binance key restrictions use mainnet SAPI even for USD-M. The response exposes `ipRestrict`, not
  the actual IP entries; never claim that a local list was compared with the remote allowlist.
- Accepted order IDs must survive status-query failure. Persist reconciliation with the terminal
  result/audit outbox so recovery never resubmits an order merely because reconciliation was unavailable.
- Approval health probes must use schema-valid records (`Environment` has no `test` value), with an
  immediate insert/read/delete transaction; keep `AuditWriter.write()`'s void callback contract.
- `generate:json-schema` emits plain pretty JSON. Run Biome formatting on `packages/schemas/json-schema`
  afterward to preserve repository formatting before linting.
- Cross-component HTTP acceptance starts compiled Guardrail/Broker/Agent entrypoints; mock only
  remote OpenAI/OPA HTTP infrastructure, not service classes. Adapter/red-team test projects
  reference runtime so its shared test harness is built before their tests.
- Container egress failures alone do not prove filtering: use an actually reachable same-bridge
  TCP/UDP witness and this run's NFLOG/log suffix, then prove the verifier detects a scoped bypass.
  Disposable Compose `down --rmi local` already removes the generated Agent image tag.
- Keep `*.sandbox.test.ts` out of ordinary unit/integration discovery. Dedicated testnet credentials
  plus an explicit sandbox command opt into orders; no credentials means skipped, never live proof.
- `EvmJsonRpcProvider` and `SolanaJsonRpcProvider` require explicit `chainEnvironment`; mainnet
  binds to Ethereum chain ID 1 or Solana mainnet-beta genesis. Network support is separate from
  deployment environment: mainnet signatures require live profiles and human approval, while
  Broker still rejects the reserved production profile and local dev signers remain testnet-only.
- Guardrail must reuse the Solana connector's trusted decoder for encoded instruction policy facts;
  rejecting all `instruction.data` prevents real System/SPL transfers from ever reaching approval.
- Decision APIs return classifications, not prose: Jev uses question/answer maps, OpenAI Decisions
  uses named arrays (including refusals), and Cloudflare Clef REST adds a `success`/`result`
  envelope. Bind and validate every required answer; do not invent model explanations or treat
  vendor confidence scales as interchangeable approval thresholds.
- Hosted Clef silently truncates text state. Bound the complete serialized UTF-8 request plus
  provider-added question/option framing before dispatch; state-only or character-count limits
  miss schema overhead, multibyte text and JSON escaping.
- Security baseline: Node 22.23.4+ (22.x) or 24.22.1+, including CI and every Docker
  builder/runtime stage. Explicit Bookworm bases keep the CA floor unambiguous:
  install `ca-certificates>=20250419~deb12u2` in every image/stage.
- Audit at all severities, not only high: Vite/PostCSS/Vitest and Solana's legacy
  Jayson graph carried lower-severity advisories too. Jayson 5 drops UUID/stream-json;
  do not override stream-json 1.x to ESM-only 3.x under a CommonJS consumer.
- pnpm release-age exclusions accept scoped name globs (`@vitest/*`) but not a
  name glob combined with a version (`@vitest/*@4.1.12`). Keep the age policy active.
- Bound final Vitest runs with `--maxWorkers=2`. Host HTTP acceptance uses the
  existing stack harness and paper execution, never live credentials or Docker mutation.
- Zod 4.6.6+ rejects oversized arrays before parsing elements only when a leading upper
  bound is declared; upgrading alone does not bound unbounded arrays, and Zod 3 `.max()`
  still walked them. Keep Intent collection caps and nested `action`/`chain` discriminators.
  Native `z.toJSONSchema` replaces `zod-to-json-schema`; use draft-7 input conversion.
