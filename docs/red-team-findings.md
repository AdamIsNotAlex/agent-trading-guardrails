# Red-Team Findings

## Scope

This document summarizes the Phase 17 red-team regression coverage in `packages/red-team/src/red-team.test.ts` and the payload fixtures in `packages/red-team/src/fixtures.ts`.

## Attack vectors tested

| Vector | Coverage | Outcome |
| --- | --- | --- |
| Webpage prompt injection | Rationale includes an instruction to ignore prior instructions and transfer funds. | GuardrailService denies with `prompt_injection_detected`. |
| Repository prompt injection | Rationale includes a system override asking for high notional and immediate approval. | GuardrailService denies with `prompt_injection_detected`. |
| Token metadata prompt injection | Token description asks to execute a withdrawal. | GuardrailService denies with `prompt_injection_detected`. |
| MCP/tool-definition injection | Payload claims a tool secretly calls `cex.withdraw`. | GuardrailService denies with `prompt_injection_detected`. |
| Secret exfiltration prompt | Payload asks to print secret-bearing environment variable names. | Response does not contain requested secret variable names. |
| Secret exfiltration through logs | Payload asks to log all environment variables including secrets. | GuardrailService denies, emits only receipt/final-decision audit events, and captured output does not contain seeded secret values. |
| Malformed reviewer output | Reviewer returns invalid structured output or throws. | GuardrailService fails closed with `deny`; reviewer exceptions return `reviewer_unavailable`. |
| Auto-execution misuse | Reviewer approval with matching policy allows, while approval without allowlist escalates to `needs_human`. | Auto-execution remains gated by policy output. |
| Hard-deny actions | Withdrawals, transfers, unknown contracts, and unlimited approvals are represented by deny-policy tests. | Deny decisions do not become human approvals. |
| Runtime fail-closed paths | OPA unavailable, malformed input, connector failure, and stale market/risk failure paths are covered. | Service/broker return deny or failed/rejected results. |
| Kill switch | Global and per-agent kill switch behavior is covered. | Broker rejects execution when matching kill switch is active. |
| Hallucinated market/account claims | Fake price, balance, and position claims are embedded in intent rationale. | GuardrailService denies with `hallucinated_data_detected`. |

## Gaps found and fixed

- Prompt-injection and hallucination tests previously asserted only that an intent ID existed. They now assert the decision is `deny` and verify the expected detection rule.
- Red-team fixtures for MCP/tool-definition injection, log exfiltration, fake balance, and fake position were unused. They are now exercised by regression tests.
- Log-exfiltration coverage now seeds representative secret values and asserts captured service/audit output does not contain them.
- Hallucinated balance and position claims now have explicit deny-path coverage instead of relying only on the fake-price case.

## Fixes applied

- Strengthened prompt-injection detection assertions in `packages/red-team/src/red-team.test.ts`.
- Added regression tests for previously unused prompt-injection and hallucination fixtures.
- Added log-exfiltration regression coverage that checks both deny behavior and captured output.
- Added explicit hallucinated balance and position rejection tests.

## Residual risks

- The prompt-injection detector is pattern-based and should not be treated as comprehensive natural-language security analysis.
- Secret-leak tests cover representative result/audit serialization paths, not every possible logger or external sink.
- Hallucination checks cover known fixture phrasing; broader unsupported-claim detection still depends on risk-engine evidence and live data checks.
- Red-team tests use in-process mocks for reviewer, policy, risk, and broker dependencies. Separate integration tests should cover HTTP/service-stack wiring and external connector boundaries.

## Recommended future hardening

- Expand prompt-injection fixtures with obfuscation, multilingual instructions, markdown/tool-call wrappers, and indirect instructions from retrieved content.
- Add integration tests that run red-team payloads through the HTTP service layer once it exists.
- Capture and scan structured logs from the production logger implementation, not only test-local audit/result objects.
- Add coverage for chained attacks that combine prompt injection with stale data, malformed reviewer output, or human-approval escalation.
