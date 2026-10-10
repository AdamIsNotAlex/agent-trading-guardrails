#!/bin/sh
# Network namespace sidecar. Root in this container only; never give Agent NET_ADMIN.
# Caps: NET_ADMIN + NET_BIND_SERVICE + SETGID (dnsmasq initializes its group list).
# SIGKILL cannot run this script; deny-by-default/role rules already in the netns remain.
set -eu
umask 027
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

LOCKDOWN_NFT=/etc/guardrails/nft-lockdown.nft
LOGDIR=/var/log/guardrails/network
READY=/run/network-ready
DNSMASQ_PIDFILE=/run/dnsmasq.pid
ULOGD_PIDFILE=/run/ulogd.pid
locking_down=0
ulogd_pid=
dnsmasq_pid=
rotate_pid=

log() { echo "network-sidecar: $*" >&2; }

die() {
	log "FATAL: $*"
	lockdown
	exit 1
}

lockdown() {
	if [ "$locking_down" -eq 1 ]; then
		return 0
	fi
	locking_down=1
	rm -f "$READY"
	nft -f "$LOCKDOWN_NFT" || log "lockdown nft apply failed"
	if [ -n "${rotate_pid:-}" ]; then
		kill "$rotate_pid" 2>/dev/null || true
	fi
	if [ -n "${dnsmasq_pid:-}" ]; then
		kill "$dnsmasq_pid" 2>/dev/null || true
	fi
	if [ -n "${ulogd_pid:-}" ]; then
		kill "$ulogd_pid" 2>/dev/null || true
	fi
}

on_signal() {
	log "signal, applying lockdown"
	lockdown
	exit 1
}

trap on_signal INT TERM
trap 'lockdown' EXIT

command -v nft >/dev/null || die "nft not installed"
command -v dnsmasq >/dev/null || die "dnsmasq not installed"
command -v ulogd >/dev/null || die "ulogd not installed"
command -v logrotate >/dev/null || die "logrotate not installed"

if [ "$(id -u)" -ne 0 ]; then
	die "must start as root in the sandbox (Agent stays unprivileged)"
fi

case "${NETWORK_ROLE:-}" in
agent)
	ROLE_NFT=/etc/guardrails/nft-agent.nft
	DNSMASQ_CONF=/etc/guardrails/dnsmasq-agent.conf
	;;
egress)
	ROLE_NFT=/etc/guardrails/nft-egress.nft
	DNSMASQ_CONF=/etc/guardrails/dnsmasq-egress.conf
	;;
*)
	die "NETWORK_ROLE must be agent or egress"
	;;
esac

[ -f "$LOCKDOWN_NFT" ] || die "missing $LOCKDOWN_NFT"
[ -f "$ROLE_NFT" ] || die "missing $ROLE_NFT"
[ -f "$DNSMASQ_CONF" ] || die "missing $DNSMASQ_CONF"
[ -f /etc/ulogd.conf ] || die "missing /etc/ulogd.conf"

# Fail closed before any child or allow rule exists.
nft -f "$LOCKDOWN_NFT" || die "cannot install lockdown nft (need CAP_NET_ADMIN, nftables, no fail-open)"

# Internal bridges have no default route: without this, connect() returns ENETUNREACH
# before OUTPUT and NFLOG cannot record literal-IP attempts. The route terminates
# at the internal bridge; both this namespace's default-drop rules and Docker's
# internal network remain in force. Install it only after lockdown.
if [ "$NETWORK_ROLE" = "agent" ]; then
	ip route replace default via 172.30.10.1 || die "cannot install audited Agent route"
fi

fwd=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 1)
if [ "$fwd" != "0" ]; then
	die "net.ipv4.ip_forward is $fwd; refuse to run with forwarding enabled"
fi

if [ -w /proc/sys/net/ipv6/conf/all/disable_ipv6 ]; then
	echo 1 >/proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null || true
fi
if [ -w /proc/sys/net/ipv6/conf/all/forwarding ]; then
	echo 0 >/proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || true
fi

mkdir -p /run "$LOGDIR"
touch "$LOGDIR/dns.log" "$LOGDIR/blocked-egress.log" /run/ulogd-daemon.log
chmod 0750 "$LOGDIR"
chmod 0640 "$LOGDIR/dns.log" "$LOGDIR/blocked-egress.log"

# Logger before traffic: NFLOG packets would otherwise be dropped with no record.
ulogd -c /etc/ulogd.conf -p "$ULOGD_PIDFILE" -l 5 &
ulogd_pid=$!
i=0
while [ "$i" -lt 50 ]; do
	if [ -f "$ULOGD_PIDFILE" ] && kill -0 "$(cat "$ULOGD_PIDFILE")" 2>/dev/null; then
		break
	fi
	if ! kill -0 "$ulogd_pid" 2>/dev/null; then
		die "ulogd exited (NFLOG/nfnetlink_log unsupported or EPERM; no dmesg fallback)"
	fi
	i=$((i + 1))
	sleep 0.1
done
kill -0 "$ulogd_pid" 2>/dev/null || die "ulogd failed to start"
if grep -Eiq 'error|cannot bind|permission|no such|failed' /run/ulogd-daemon.log 2>/dev/null; then
	die "ulogd reported a logging error (no fail-open)"
fi

dnsmasq -C "$DNSMASQ_CONF" --pid-file="$DNSMASQ_PIDFILE" --log-facility="$LOGDIR/dns.log" &
dnsmasq_pid=$!
i=0
while [ "$i" -lt 50 ]; do
	if [ -f "$DNSMASQ_PIDFILE" ] && kill -0 "$(cat "$DNSMASQ_PIDFILE")" 2>/dev/null; then
		if grep -q '0100007F:0035' /proc/net/udp /proc/net/tcp 2>/dev/null; then
			break
		fi
	fi
	if ! kill -0 "$dnsmasq_pid" 2>/dev/null; then
		die "dnsmasq exited; inspect $LOGDIR/dns.log for the startup error"
	fi
	i=$((i + 1))
	sleep 0.1
done
grep -q '0100007F:0035' /proc/net/udp /proc/net/tcp 2>/dev/null || die "dnsmasq is not listening on 127.0.0.1:53"
if grep -q '00000000:0035' /proc/net/udp /proc/net/tcp /proc/net/udp6 /proc/net/tcp6 2>/dev/null; then
	die "dnsmasq bound 0.0.0.0:53 or [::]:53"
fi

# Role allow rules only after logger + resolver are alive.
nft -f "$ROLE_NFT" || die "cannot install $NETWORK_ROLE nft rules (kernel/permission; leaving lockdown)"

if [ "$NETWORK_ROLE" = "agent" ]; then
	nft list table inet guardrails | grep -q 'ip daddr 172.30.10.20 tcp dport 8080 accept' || die "agent allow-proxy rule missing"
	if nft list table inet guardrails | grep -q 'ip daddr 172.30.10.20 tcp dport 8081'; then
		die "agent must not allow proxy:8081"
	fi
else
	nft list table inet guardrails | grep -q 'tcp dport 8080 accept' || die "egress allow-8080 rule missing"
	nft list table inet guardrails | grep -q 'tcp dport 8081 accept' || die "egress allow-8081 rule missing"
	nft list table inet guardrails | grep -q 'ip daddr 172.30.20.20 tcp dport 3000 accept' || die "egress allow-guardrail rule missing"
	nft list table inet guardrails | grep -q 'ip daddr 1.1.1.1' || die "egress allow-upstream-dns rule missing"
fi
nft list table inet guardrails | grep -q 'ip daddr 127.0.0.11' || die "127.0.0.11 drop missing"
nft list table inet guardrails | grep -q 'log prefix "blocked-egress "' || die "blocked-egress NFLOG rule missing"
nft list table inet guardrails | grep -q 'priority raw' || die "raw OUTPUT hook missing (must precede Docker DNAT)"

: >"$READY"
log "ready role=${NETWORK_ROLE}"

(
	while kill -0 "$ulogd_pid" 2>/dev/null && kill -0 "$dnsmasq_pid" 2>/dev/null; do
		if ! logrotate --state /run/logrotate.state /etc/guardrails/logrotate.conf; then
			log "logrotate failed"
			exit 1
		fi
		sleep 60
	done
	exit 1
) &
rotate_pid=$!

while :; do
	if ! kill -0 "$ulogd_pid" 2>/dev/null; then
		die "ulogd died"
	fi
	if ! kill -0 "$dnsmasq_pid" 2>/dev/null; then
		die "dnsmasq died"
	fi
	if ! kill -0 "$rotate_pid" 2>/dev/null; then
		die "logrotate loop died"
	fi
	sleep 1
done
