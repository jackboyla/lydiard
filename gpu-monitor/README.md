# Radiance GPU monitor

A dependency-free, read-only dashboard for NVIDIA GPU metrics, owning processes, and the tmux panes that contain those processes.

## Access

- On the workstation or through an SSH port forward: `http://127.0.0.1:8789`
- From this tailnet: `http://workstation:8789` or `http://100.x.y.z:8789`

For an SSH-only laptop connection, add local forwarding with `ssh -L 8789:127.0.0.1:8789 workstation`, then open `http://127.0.0.1:8789` on the laptop.

The service listens only on loopback and the workstation's Tailscale IPv4 address. It has no write, signal, terminal-input, or process-control endpoints.

## Deployment

The workstation's user systemd manager can itself be killed during a global out-of-memory event. A cron watchdog therefore checks the local health endpoint every minute and relaunches the monitor independently when required:

```bash
crontab gpu-monitor/gpu-monitor.crontab
gpu-monitor/watchdog.sh
```

Monitor output is appended to `progress/logs/gpu-monitor.log`. The legacy user unit is retained as documentation but is suppressed by `.local/gpu-monitor-cron-managed` to prevent two supervisors competing for port 8789.

## Development

```bash
node --test gpu-monitor/monitor.test.mjs
node gpu-monitor/server.mjs
bash -n gpu-monitor/watchdog.sh
```

GPU output is available when the owning process descends from a live tmux pane. Jobs outside tmux still appear with their GPU and process metrics, but do not have retrievable terminal history.
