# Layup dev VM

Everything the VM runs is a file in this directory. Nothing is hand-edited on
the server, so the box is reproducible and the configuration is reviewable.

`make deploy` ships the `layup-control` binary. `bootstrap.sh` ships the
configuration: packages, the systemd unit, the Caddy site, coturn, and the
firewall. Re-run `bootstrap.sh` after any config change here - it is
idempotent.

## First run

`bootstrap.sh` refuses to run until `/etc/layup/control.env` exists on the
server with real secrets in it - that file is never committed, so it has to
be created by hand from `control.env.example` first.

There are **two** `REPLACE_ME`s in that template and `bootstrap.sh` refuses to
proceed while either survives: `LAYUP_TURN_SECRET`, which coturn shares, and
`LAYUP_JOIN_CODE`, which is the only thing standing between a stranger and an
identity on this server. It also refuses `LAYUP_ENV=dev`, because that value
makes the control service believe an `X-Layup-Dev-User` header from any caller
anywhere - fine on a laptop, an impersonation hole on a public box.

```bash
openssl rand -hex 32                      # the TURN secret; keep this
openssl rand -hex 4                       # the join code; keep this too
ssh root@157.20.113.124 'mkdir -p /etc/layup'
scp deploy/vm/control.env.example root@157.20.113.124:/etc/layup/control.env
ssh root@157.20.113.124 'vi /etc/layup/control.env'   # paste both, leave LAYUP_ENV alone
scp -r deploy/vm root@157.20.113.124:/tmp/layup-vm
ssh root@157.20.113.124 'bash /tmp/layup-vm/bootstrap.sh'
```

## The firewall

`bootstrap.sh` installs `nftables.conf` and applies it with:

```bash
systemctl enable nftables
systemctl restart nftables
```

`nftables.service` is `Type=oneshot` with `RemainAfterExit=yes`: once the
unit is active, `start` (and therefore `enable --now`, which is `start`
under the hood) is a no-op on an already-active unit - systemd will not
re-run `ExecStart`, so edits to `nftables.conf` would silently never load.
`restart` re-executes `ExecStart` unconditionally, which is what makes
re-running `make deploy-config` after editing `nftables.conf` actually apply
the change - the whole point of the script being idempotent. `enable` stays
a separate, ordinary call since wiring the unit into boot is idempotent on
its own.

The firewall is applied on every run of `bootstrap.sh` (i.e. every
`make deploy-config`), giving the box a default-drop input policy with an
allow-list for ssh (22), ACME/redirect (80), Caddy (443), TURN (3478 tcp+udp)
and the TURN relay range (49160-49200/udp). It **will not lock out ssh**,
because port 22 is in the allow-list in `nftables.conf` - confirmed on the
real box: the ssh session used to apply the ruleset survives the ruleset
being applied, and a follow-up `ssh` call after the fact still succeeds.

Proof the firewall actually blocks unpermitted traffic, run from outside the
VM against a port not in the allow-list:

```bash
curl -sv -m 6 http://157.20.113.124:8080/
# * Trying 157.20.113.124:8080...
# * Connection timed out after 6005 milliseconds
```

Separately: `http://157.20.113.124:8787/healthz` (the control service's own
port, bypassing Caddy/TLS) has never answered from outside, firewall or not
- `LAYUP_LISTEN_ADDR=127.0.0.1:8787` binds the control service to loopback
only, so it was never reachable off-host in the first place. Before the
firewall was active, a request to it from outside failed instantly with
"connection refused" (nothing listening on the public interface); with the
firewall active it now times out instead (packets to 8787 are dropped before
they'd even reach the point of finding no listener). Same non-result, two
different reasons - the firewall adds defence in depth on a port that was
never actually exposed, rather than closing a hole that existed.

## DNS

`bootstrap.sh` checks it can resolve `deb.debian.org` before touching apt,
and fails fast with a remedy if not - this VM's resolver has been observed
unreachable (its only configured nameserver was Tailscale MagicDNS, on a box
without `tailscale` installed), and without the check `apt-get` just hangs.
The remedy it prints:

```bash
resolvectl dns eth0 1.1.1.1 8.8.8.8
```

**This does not survive a reboot.** It is a live override of
`systemd-resolved`, not a change to any file `bootstrap.sh` manages - if the
VM reboots and DNS breaks again, run it by hand before re-running
`bootstrap.sh`.

## Resetting identities before a real pairing session

**`make reset-identities` is destructive: it logs everybody out.** It deletes
`/var/lib/layup/identities.json` on the VM and restarts `layup-control`, which
throws away every registered identity and every token issued for it. Nobody
who was registered can do anything until they re-register with the join code
- there is no partial or per-user version of this.

It exists because every run of the network harnesses
(`test/network/remote-health.mjs`, `test/network/turn-remote.mjs`) registers a
fresh throwaway identity of its own ("remote-health harness", "turn-remote
harness", ...). Those harnesses run often during development, presence fans
out over the same `directory.Users()` the People grid reads
(`services/control/internal/presencefeed/feed.go`), so harness junk
accumulates in the directory and shows up next to real people.

Run it once, immediately before a real two-person session, so the People grid
starts empty and only the two people actually pairing appear in it:

```bash
make reset-identities
# then both people register fresh: Add a server -> layup.blah.au -> the join code
```

Do not run it while anyone is mid-session - it ends their session too.
