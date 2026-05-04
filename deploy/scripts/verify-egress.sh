#!/usr/bin/env bash
set -euo pipefail

# Verify that the agent container cannot reach blocked destinations.
# Run this after `docker compose up -d`.

AGENT_CONTAINER="${1:-agent-trading-guardrails-agent-1}"

echo "=== Egress Verification for Agent Container ==="
echo "Container: $AGENT_CONTAINER"
echo ""

FAILURES=0

check_blocked() {
  local desc="$1"
  local cmd="$2"
  if docker exec "$AGENT_CONTAINER" sh -c "$cmd" 2>/dev/null; then
    echo "FAIL: $desc — should be blocked but succeeded"
    FAILURES=$((FAILURES + 1))
  else
    echo "PASS: $desc — blocked as expected"
  fi
}

check_allowed() {
  local desc="$1"
  local cmd="$2"
  if docker exec "$AGENT_CONTAINER" sh -c "$cmd" 2>/dev/null; then
    echo "PASS: $desc — allowed as expected"
  else
    echo "FAIL: $desc — should be allowed but was blocked"
    FAILURES=$((FAILURES + 1))
  fi
}

# Blocked: direct CEX API access
check_blocked "Binance API direct" "wget -q -O /dev/null --timeout=3 https://api.binance.com/api/v3/ping"

# Blocked: direct RPC access
check_blocked "Ethereum RPC direct" "wget -q -O /dev/null --timeout=3 https://mainnet.infura.io"

# Blocked: metadata service
check_blocked "AWS metadata service" "wget -q -O /dev/null --timeout=3 http://169.254.169.254/latest/meta-data/"

# Blocked: internal ranges
check_blocked "RFC1918 10.x" "wget -q -O /dev/null --timeout=3 http://10.0.0.1/"
check_blocked "RFC1918 172.16.x" "wget -q -O /dev/null --timeout=3 http://172.16.0.1/"
check_blocked "RFC1918 192.168.x" "wget -q -O /dev/null --timeout=3 http://192.168.1.1/"

# Blocked: Docker socket
check_blocked "Docker socket" "ls /var/run/docker.sock"

# Verify: no host home directory mounted
check_blocked "Host home directory" "ls /root/.ssh 2>/dev/null || ls /home/*/.ssh 2>/dev/null"

echo ""
echo "=== Results ==="
if [ "$FAILURES" -eq 0 ]; then
  echo "All egress checks passed."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
