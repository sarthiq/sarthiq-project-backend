#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# setup-log-rotation.sh
# Run this on srv847602 to configure log rotation and prevent
# /var/log from growing unbounded.
#
# Usage: sudo bash scripts/setup-log-rotation.sh
# ─────────────────────────────────────────────────────────────────────

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SarthiQ Log Rotation Setup                              ║"
echo "╚══════════════════════════════════════════════════════════╝"

# ── 1. Kubernetes pod/container log rotation ───────────────────────
echo ""
echo "📁 [1/5] Setting up Kubernetes pod log rotation..."

cat > /etc/logrotate.d/kubernetes-pods << 'EOF'
# Rotate Kubernetes pod and container logs
/var/log/pods/*/*.log
/var/log/pods/*/*/*.log
/var/log/containers/*.log {
    daily
    rotate 3
    compress
    missingok
    notifempty
    maxsize 100M
    copytruncate
    su root root
}
EOF

echo "  ✓ Created /etc/logrotate.d/kubernetes-pods"

# ── 2. System log rotation hardening ──────────────────────────────
echo ""
echo "📁 [2/5] Hardening system log rotation..."

# Backup existing syslog config
if [ -f /etc/logrotate.d/rsyslog ]; then
    cp /etc/logrotate.d/rsyslog /etc/logrotate.d/rsyslog.bak
fi

cat > /etc/logrotate.d/rsyslog << 'EOF'
/var/log/syslog
/var/log/mail.info
/var/log/mail.warn
/var/log/mail.err
/var/log/mail.log
/var/log/daemon.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
/var/log/lpr.log
/var/log/cron.log
/var/log/debug
/var/log/messages
{
    daily
    rotate 3
    compress
    delaycompress
    missingok
    notifempty
    maxsize 200M
    copytruncate
    su root syslog
}
EOF

echo "  ✓ Updated /etc/logrotate.d/rsyslog (maxsize 200M, rotate 3)"

# ── 3. Kubelet container log limits ──────────────────────────────
echo ""
echo "📁 [3/5] Configuring kubelet container log limits..."

KUBELET_CONFIG="/var/lib/kubelet/config.yaml"

if [ -f "$KUBELET_CONFIG" ]; then
    # Check if containerLogMaxSize is already set
    if ! grep -q "containerLogMaxSize" "$KUBELET_CONFIG"; then
        echo "" >> "$KUBELET_CONFIG"
        echo "# Added by SarthiQ log rotation setup" >> "$KUBELET_CONFIG"
        echo "containerLogMaxSize: \"50Mi\"" >> "$KUBELET_CONFIG"
        echo "containerLogMaxFiles: 3" >> "$KUBELET_CONFIG"
        echo "  ✓ Added containerLogMaxSize (50Mi) and containerLogMaxFiles (3) to kubelet config"
        echo "  ⚠ Kubelet restart required: systemctl restart kubelet"
    else
        echo "  ✓ containerLogMaxSize already configured in kubelet config"
    fi
else
    echo "  ⚠ Kubelet config not found at $KUBELET_CONFIG"
    echo "    You may need to add these flags to kubelet service file:"
    echo "    --container-log-max-size=50Mi --container-log-max-files=3"
fi

# ── 4. Systemd journal size limit ────────────────────────────────
echo ""
echo "📁 [4/5] Configuring systemd journal size limit..."

JOURNAL_CONF="/etc/systemd/journald.conf"

if [ -f "$JOURNAL_CONF" ]; then
    # Set max journal size
    if grep -q "^SystemMaxUse=" "$JOURNAL_CONF"; then
        sed -i 's/^SystemMaxUse=.*/SystemMaxUse=500M/' "$JOURNAL_CONF"
    elif grep -q "^#SystemMaxUse=" "$JOURNAL_CONF"; then
        sed -i 's/^#SystemMaxUse=.*/SystemMaxUse=500M/' "$JOURNAL_CONF"
    else
        echo "SystemMaxUse=500M" >> "$JOURNAL_CONF"
    fi

    if grep -q "^SystemMaxFileSize=" "$JOURNAL_CONF"; then
        sed -i 's/^SystemMaxFileSize=.*/SystemMaxFileSize=100M/' "$JOURNAL_CONF"
    elif grep -q "^#SystemMaxFileSize=" "$JOURNAL_CONF"; then
        sed -i 's/^#SystemMaxFileSize=.*/SystemMaxFileSize=100M/' "$JOURNAL_CONF"
    else
        echo "SystemMaxFileSize=100M" >> "$JOURNAL_CONF"
    fi

    echo "  ✓ Set journal SystemMaxUse=500M, SystemMaxFileSize=100M"
    echo "  ⚠ Restart journald: systemctl restart systemd-journald"
else
    echo "  ⚠ journald.conf not found at $JOURNAL_CONF"
fi

# ── 5. Docker daemon log limits ──────────────────────────────────
echo ""
echo "📁 [5/5] Configuring Docker daemon log limits..."

DOCKER_DAEMON="/etc/docker/daemon.json"

if [ -f "$DOCKER_DAEMON" ]; then
    # Check if log-opts is already configured
    if ! grep -q "max-size" "$DOCKER_DAEMON"; then
        echo "  ⚠ Please manually add log-opts to $DOCKER_DAEMON:"
        echo '    "log-opts": { "max-size": "50m", "max-file": "3" }'
    else
        echo "  ✓ Docker log rotation already configured"
    fi
else
    cat > "$DOCKER_DAEMON" << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
EOF
    echo "  ✓ Created $DOCKER_DAEMON with log rotation (50m max, 3 files)"
    echo "  ⚠ Restart Docker: systemctl restart docker"
fi

# ── Summary ──────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Setup Complete!                                         ║"
echo "║                                                          ║"
echo "║  Restart required services:                              ║"
echo "║    sudo systemctl restart systemd-journald               ║"
echo "║    sudo systemctl restart kubelet                        ║"
echo "║    sudo systemctl restart docker                         ║"
echo "║                                                          ║"
echo "║  Test logrotate:                                         ║"
echo "║    sudo logrotate -f /etc/logrotate.d/kubernetes-pods    ║"
echo "║                                                          ║"
echo "║  Monitor disk usage:                                     ║"
echo "║    watch -n 5 'du -sh /var/log && df -h /'              ║"
echo "╚══════════════════════════════════════════════════════════╝"
