# Keeping a production instance running

Two systemd **user** units keep the terminal on `http://127.0.0.1:4242` and the OpenBB API on `:6900`, restarting them on crash and on boot (needs `loginctl enable-linger $USER` so user units start without a login).

```sh
loginctl enable-linger "$USER"
systemctl --user link "$PWD/deploy/systemd/openbb-api.service" "$PWD/deploy/systemd/terminal.service"
systemctl --user daemon-reload
systemctl --user enable --now openbb-api.service terminal.service
```

Assumptions baked into the units (edit them if yours differ): the repo at `~/terminal`, node at `~/.local/bin/node`, OpenBB in the venv `~/.venvs/openbb`, keys in `~/terminal/.env` (`ANTHROPIC_API_KEY=...`). The connector list and the finnhub key live in `~/.terminal/config.yml`.

The server serves the built web app, so after pulling or editing run `deploy/redeploy.sh`: it reinstalls, rebuilds `packages/web/dist` and restarts the service. Logs: `journalctl --user -u terminal.service -f`.

Both services bind loopback only. To use the UI from another machine, tunnel: `ssh -L 4242:127.0.0.1:4242 <vm>` and open `http://localhost:4242`.
