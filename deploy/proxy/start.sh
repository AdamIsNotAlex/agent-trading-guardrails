#!/bin/sh
set -eu
umask 027
nginx -t
nginx -g 'daemon off;' &
nginx_pid=$!
rotate_pid=
stop() {
    trap - EXIT INT TERM
    [ -z "$rotate_pid" ] || kill "$rotate_pid" 2>/dev/null || true
    kill -QUIT "$nginx_pid" 2>/dev/null || true
    wait "$nginx_pid" 2>/dev/null || true
}
trap stop EXIT INT TERM
(
    while kill -0 "$nginx_pid" 2>/dev/null; do
        if ! logrotate --state /tmp/logrotate.state /etc/guardrails-logrotate.conf; then
            kill -TERM "$nginx_pid"
            exit 1
        fi
        sleep 60
    done
) &
rotate_pid=$!
wait "$nginx_pid"
