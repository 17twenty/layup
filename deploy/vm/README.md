# Layup dev VM

Everything the VM runs is a file in this directory. Nothing is hand-edited on
the server, so the box is reproducible and the configuration is reviewable.

`make deploy` ships the `layup-control` binary. `bootstrap.sh` ships the
configuration: packages, the systemd unit, the Caddy site, coturn, and the
firewall. Re-run `bootstrap.sh` after any config change here - it is
idempotent.

## First run

`bootstrap.sh` refuses to run until `/etc/layup/control.env` exists on the
server with a real secret in it - that file is never committed, so it has to
be created by hand from `control.env.example` first.

```bash
openssl rand -hex 32                      # keep this
ssh root@157.20.113.124 'mkdir -p /etc/layup'
scp deploy/vm/control.env.example root@157.20.113.124:/etc/layup/control.env
ssh root@157.20.113.124 'vi /etc/layup/control.env'   # paste the secret
scp -r deploy/vm root@157.20.113.124:/tmp/layup-vm
ssh root@157.20.113.124 'bash /tmp/layup-vm/bootstrap.sh'
```

## The firewall

The firewall is applied by `systemctl start nftables` (which `bootstrap.sh`
enables) and **will not lock out ssh**, because port 22 is in the allow-list
in `nftables.conf`.
