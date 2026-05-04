# OPA/Rego Policy Layer

## TypeScript Normalization → OPA

The guardrail service normalizes trading intents into a flat `PolicyInput` object before passing it to OPA. The TypeScript layer handles:

1. **Schema validation** — Zod validates the raw intent structure
2. **Reviewer evaluation** — The reviewer agent returns a structured verdict
3. **Dynamic risk checks** — Live data checks (market freshness, portfolio state, etc.)
4. **Fact normalization** — Extract fields from the intent into the `PolicyInput` shape

The normalized `PolicyInput` is then sent to OPA as `input`. OPA evaluates the policy rules and returns a decision.

### PolicyInput fields fed to OPA

| Field | Source |
|-------|--------|
| `intentId` | From intent envelope |
| `principal` | From intent envelope |
| `action` | From intent envelope |
| `resource` | From intent envelope |
| `environment` | From intent envelope |
| `exchange`, `accountMode`, `symbol` | From CEX intents |
| `chain`, `chainEnvironment` | From onchain intents |
| `maxNotionalUsd`, `leverage` | From order intents |
| `maxTokenApprovalAmount` | From signing intents |
| `reviewerVerdict`, `reviewerRiskLevel` | From reviewer verdict |
| `reviewerDetectedIssues` | From reviewer verdict |
| `dailyNotionalUsd`, `dailyRealizedLossUsd` | From risk engine |

## OPA v1.16.1 Upgrade Process

1. Check the [OPA releases page](https://github.com/open-policy-agent/opa/releases) for the new version.
2. Download the new `opa_linux_amd64_static` binary.
3. Verify the SHA256 checksum from the release assets.
4. Update `.github/workflows/ci.yml` with the new version and checksum.
5. Update `docker-compose.yml` with the new image tag and digest.
6. Run all Rego tests with the new binary: `opa test packages/policy/src -v`
7. Commit the version bump with recorded checksums.

### Current pinned version

- **Binary:** `opa_linux_amd64_static` v1.16.1
- **CI checksum:** `dc00b1c32c52f1557f7f127940bc3f1de6c507fdfbe0446f19d3b19ca5786494`
- **Docker image:** `openpolicyagent/opa:1.16.1-static@sha256:637ffdb793e146e50ec45cc023ee78fc5bc52c11816ce7adee41ce20e46e5ed8`
