#!/bin/sh
# Agent sandbox readiness does not probe 8080/proxy (avoids compose cycles).
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin

[ -f /run/network-ready ] || exit 1
[ -f /run/dnsmasq.pid ] || exit 1
[ -f /run/ulogd.pid ] || exit 1
kill -0 "$(cat /run/dnsmasq.pid)" || exit 1
kill -0 "$(cat /run/ulogd.pid)" || exit 1

role=${NETWORK_ROLE:-}
[ "$role" = "agent" ] || [ "$role" = "egress" ] || exit 1

rules=$(/usr/sbin/nft list table inet guardrails) || exit 1
printf '%s\n' "$rules" | grep -q 'ip daddr 127.0.0.11' || exit 1
printf '%s\n' "$rules" | grep -q 'log prefix "blocked-egress "' || exit 1
printf '%s\n' "$rules" | grep -q 'priority raw' || exit 1
printf '%s\n' "$rules" | grep -q 'ip saddr 127.0.0.1 ip daddr 127.0.0.1 udp dport 53 accept' || exit 1

if [ "$role" = "agent" ]; then
	printf '%s\n' "$rules" | grep -q 'ip daddr 172.30.10.20 tcp dport 8080 accept' || exit 1
	if printf '%s\n' "$rules" | grep -q 'ip daddr 172.30.10.20 tcp dport 8081'; then
		exit 1
	fi
	if printf '%s\n' "$rules" | grep -q 'ip daddr 1.1.1.1'; then
		exit 1
	fi
else
	printf '%s\n' "$rules" | grep -q 'tcp dport 8080 accept' || exit 1
	printf '%s\n' "$rules" | grep -q 'tcp dport 8081 accept' || exit 1
	printf '%s\n' "$rules" | grep -q 'ip daddr 172.30.20.20 tcp dport 3000 accept' || exit 1
	printf '%s\n' "$rules" | grep -q 'ip daddr 1.1.1.1' || exit 1
	printf '%s\n' "$rules" | grep -q 'set nonglobal4' || exit 1
fi

grep -q '0100007F:0035' /proc/net/udp /proc/net/tcp || exit 1
if grep -q '00000000:0035' /proc/net/udp /proc/net/tcp /proc/net/udp6 /proc/net/tcp6 2>/dev/null; then
	exit 1
fi

[ -f /proc/net/netfilter/nfnetlink_log ] || exit 1
[ -f /var/log/guardrails/network/dns.log ] || exit 1
[ -f /var/log/guardrails/network/blocked-egress.log ] || exit 1
[ -w /var/log/guardrails/network/dns.log ] || exit 1
[ -w /var/log/guardrails/network/blocked-egress.log ] || exit 1

[ "$(cat /proc/sys/net/ipv4/ip_forward)" = "0" ] || exit 1
exit 0
