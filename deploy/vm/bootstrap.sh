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

echo "==> dns preflight"
# apt hangs rather than failing loudly if the resolver is unreachable - seen
# in practice when this VM's only nameserver (Tailscale MagicDNS) was down.
# Fail fast with the exact remedy instead of leaving the operator to debug a
# fifteen-minute stall with no signal. We do not reconfigure DNS ourselves:
# the resolver is the operator's to manage, not bootstrap's.
if ! getent hosts deb.debian.org >/dev/null 2>&1; then
  echo "FATAL: cannot resolve deb.debian.org - DNS is broken on this VM." >&2
  echo "Remedy: resolvectl dns eth0 1.1.1.1 8.8.8.8" >&2
  echo "Note: that remedy does not survive a reboot - see deploy/vm/README.md." >&2
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
# Debian's coturn.service runs turnserver as the `turnserver` user (not
# root); it must be able to read the config holding its own shared secret.
chown root:turnserver /etc/turnserver.conf
# Same story for the log file: turnserver has no write access to /var/log
# itself, so it cannot create the file on first launch. Pre-create it so
# opening it for append/write does not require directory permissions.
# `touch` rather than `install` so a re-run does not truncate history.
touch /var/log/turnserver.log
chown turnserver:turnserver /var/log/turnserver.log
chmod 0640 /var/log/turnserver.log
# Debian ships coturn disabled until this is set.
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn

echo "==> caddy"
install -m 0644 "$ASSETS/Caddyfile" /etc/caddy/Caddyfile

echo "==> control service unit"
install -m 0644 "$ASSETS/layup-control.service" /etc/systemd/system/layup-control.service
systemctl daemon-reload

echo "==> firewall"
install -m 0644 "$ASSETS/nftables.conf" /etc/nftables.conf
# `enable` alone does not invoke ExecStart, so the ruleset never loads - and
# on an already-enabled unit `enable` is a no-op, so edited rules would never
# be applied either. `--now` is what actually (re)loads /etc/nftables.conf.
# Deliberate first activation on the production box is still a decision the
# operator makes explicitly (see README) - this line is what makes that
# decision take effect when they do.
systemctl enable --now nftables

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
