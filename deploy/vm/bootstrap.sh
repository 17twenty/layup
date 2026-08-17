#!/usr/bin/env bash
# Provisions the Layup dev VM. Safe to re-run.
#
#   scp -r deploy/vm root@157.20.113.124:/tmp/layup-vm
#   ssh root@157.20.113.124 'bash /tmp/layup-vm/bootstrap.sh'
set -euo pipefail

ASSETS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f /etc/layup/control.env ]; then
  echo "FATAL: /etc/layup/control.env is missing." >&2
  echo "Create it from control.env.example with a real LAYUP_TURN_SECRET first." >&2
  exit 1
fi

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# Caddy comes straight from Debian bookworm's own repos - no third-party
# repository needed. The packaged 2.6.2-5 has automatic HTTPS/ACME and the
# `handle` directive, which is everything Caddyfile here uses.
apt-get install -y -qq coturn nftables caddy

echo "==> service account and directories"
id -u layup >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin layup
install -d -o layup -g layup -m 0750 /var/lib/layup
install -d -m 0755 /srv/layup/public
install -d -m 0755 /var/log/caddy
chown -R caddy:caddy /var/log/caddy
chmod 0640 /etc/layup/control.env
chown root:layup /etc/layup/control.env

echo "==> coturn"
# coturn and the control service must agree on the secret; read it from the
# one file that holds it rather than duplicating it by hand.
TURN_SECRET="$(grep -E '^LAYUP_TURN_SECRET=' /etc/layup/control.env | cut -d= -f2-)"
if [ -z "$TURN_SECRET" ] || [ "$TURN_SECRET" = "REPLACE_ME" ]; then
  echo "FATAL: LAYUP_TURN_SECRET is unset or still REPLACE_ME." >&2
  exit 1
fi
sed "s|^static-auth-secret=.*|static-auth-secret=${TURN_SECRET}|" \
  "$ASSETS/turnserver.conf" > /etc/turnserver.conf
chmod 0640 /etc/turnserver.conf
# Debian ships coturn disabled until this is set.
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

echo "==> caddy"
install -m 0644 "$ASSETS/Caddyfile" /etc/caddy/Caddyfile

echo "==> control service unit"
install -m 0644 "$ASSETS/layup-control.service" /etc/systemd/system/layup-control.service
systemctl daemon-reload

echo "==> firewall"
install -m 0644 "$ASSETS/nftables.conf" /etc/nftables.conf
systemctl enable nftables

echo "==> start"
systemctl enable --now coturn caddy
systemctl restart coturn caddy
# layup-control only starts once a binary has been shipped by `make deploy`.
if [ -x /usr/local/bin/layup-control ]; then
  systemctl enable --now layup-control
  systemctl restart layup-control
else
  echo "note: /usr/local/bin/layup-control not present yet - run 'make deploy'"
fi

echo "bootstrap OK"
