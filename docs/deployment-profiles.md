# Deployment Profiles

## Overview

The framework supports multiple deployment profiles. Each profile defines how components are deployed, how secrets are managed, and what network controls are enforced.

## Local Docker (Development)

- All components run in Docker Compose.
- Agent runs in a dedicated container with egress restrictions.
- OPA runs as `openpolicyagent/opa:1.16.1-static`.
- Vault runs in dev mode (dev server only — not for production).
- SQLite audit database on local volume.
- No real CEX keys or wallet keys required for `dev` and `paper` profiles.

## Single VPS

- All components on one machine.
- Vault with single-node integrated storage and documented backup/unseal workflow.
- Agent isolated via Docker with network controls.
- Egress proxy/firewall for agent container.
- SQLite audit database with regular backups.

## Kubernetes

- Components deployed as separate pods/services.
- Vault Helm deployment with integrated Raft storage and HA mode.
- Agent pods with network policies restricting egress.
- OPA as sidecar or dedicated service.
- Persistent volume for audit database.

## Cloud-Managed Runtime

- Cloud-hosted Vault/HCP or cloud secret manager adapter.
- Managed container runtime (ECS, Cloud Run, etc.).
- Cloud-native network controls and security groups.
- Cloud-managed database or persistent storage for audit.

## Vault Deployment Roadmap

| Stage | Vault Mode | Use Case |
|-------|-----------|----------|
| Local dev | Dev server | Development and tests only |
| Single VPS | Single-node integrated storage | First production deployment |
| Kubernetes | Helm with HA integrated Raft | Scalable production |
| Cloud | HCP Vault or cloud secret manager | Cloud-native production |

A guardrail enforces that production profiles cannot use Vault dev server.

## OPA Distribution

| Environment | Binary/Image | Pinned Version |
|------------|-------------|----------------|
| CI | `opa_linux_amd64_static` | v1.16.1 (checksum verified) |
| Local Docker | `openpolicyagent/opa:1.16.1-static` | Pinned by image digest |

Upgrades require explicit version bump with updated checksums.
