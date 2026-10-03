# Host maintenance

## Docker image pruning

Rebuilding the backend or client leaves the previous image behind as dangling
(untagged) layers. A host that deploys often accumulates them until the disk
fills. `update.sh` already prunes after each update; this timer covers hosts
that rebuild directly instead of running `update.sh`.

It prunes dangling images only, so the running version and any tagged rollback
target are untouched. Volumes are never involved.

Install on the host:

```bash
sudo install -m 0644 ops/maintenance/systemd/rybbit-docker-prune.service /etc/systemd/system/
sudo install -m 0644 ops/maintenance/systemd/rybbit-docker-prune.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rybbit-docker-prune.timer
```

Check it is scheduled, and run it once to reclaim space immediately:

```bash
systemctl list-timers rybbit-docker-prune.timer
sudo systemctl start rybbit-docker-prune.service
```