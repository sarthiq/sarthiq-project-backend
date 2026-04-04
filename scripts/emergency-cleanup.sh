#!/bin/bash
# ─────────────────────────────────────────────────────────────────────
# emergency-cleanup.sh
# Run this on srv847602 IMMEDIATELY to free disk space.
#
# Usage: sudo bash scripts/emergency-cleanup.sh
# ─────────────────────────────────────────────────────────────────────

set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  🚨 Emergency Disk Cleanup for srv847602                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Current disk state ───────────────────────────────────────────
echo "📊 Current disk usage:"
df -h /
echo ""
echo "📊 /var/log breakdown (top 20):"
du -sh /var/log/* 2>/dev/null | sort -rh | head -20
echo ""

# ── 1. Truncate large system logs ────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[1/6] Truncating large system logs..."

for logfile in /var/log/syslog /var/log/messages /var/log/kern.log /var/log/daemon.log /var/log/debug; do
    if [ -f "$logfile" ]; then
        SIZE=$(du -sm "$logfile" 2>/dev/null | awk '{print $1}')
        if [ "$SIZE" -gt 100 ]; then
            echo "  Truncating $logfile (${SIZE} MB)..."
            truncate -s 0 "$logfile"
        else
            echo "  $logfile is OK (${SIZE} MB)"
        fi
    fi
done

# Also truncate rotated compressed logs
find /var/log -name "*.gz" -mtime +1 -delete 2>/dev/null && echo "  Deleted old .gz log archives"
find /var/log -name "*.1" -size +100M -exec truncate -s 0 {} \; 2>/dev/null && echo "  Truncated large .1 rotated logs"

echo "  ✓ System logs cleaned"

# ── 2. Clean Kubernetes pod/container logs ───────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[2/6] Cleaning Kubernetes pod/container logs..."

K8S_LOG_SIZE=$(du -sm /var/log/pods/ 2>/dev/null | awk '{print $1}')
echo "  /var/log/pods/ size: ${K8S_LOG_SIZE:-0} MB"

# Truncate all pod logs > 50MB
find /var/log/pods/ -name "*.log" -size +50M -exec truncate -s 0 {} \; 2>/dev/null
echo "  Truncated pod logs > 50MB"

# Truncate all container logs > 50MB
find /var/log/containers/ -name "*.log" -size +50M -exec truncate -s 0 {} \; 2>/dev/null
echo "  Truncated container logs > 50MB"

echo "  ✓ K8s logs cleaned"

# ── 3. Vacuum systemd journal ────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[3/6] Vacuuming systemd journal..."

JOURNAL_SIZE=$(journalctl --disk-usage 2>/dev/null | grep -oP '\d+\.\d+[MG]' || echo "unknown")
echo "  Journal size before: $JOURNAL_SIZE"

journalctl --vacuum-size=200M 2>/dev/null || echo "  (journalctl vacuum skipped)"

echo "  ✓ Journal vacuumed to 200MB"

# ── 4. Clean PM2 logs (if PM2 is used) ──────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[4/6] Cleaning PM2 logs..."

if command -v pm2 &>/dev/null; then
    PM2_LOG_SIZE=$(du -sm ~/.pm2/logs/ 2>/dev/null | awk '{print $1}')
    echo "  PM2 logs size: ${PM2_LOG_SIZE:-0} MB"
    pm2 flush 2>/dev/null && echo "  ✓ PM2 logs flushed"
else
    echo "  PM2 not found, skipping"
fi

# ── 5. Docker cleanup ───────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[5/6] Docker cleanup..."

DOCKER_SIZE=$(docker system df 2>/dev/null | head -5 || echo "unknown")
echo "  Docker disk usage before:"
echo "$DOCKER_SIZE" | sed 's/^/    /'
echo ""

# Remove all stopped containers
docker container prune -f 2>/dev/null && echo "  ✓ Stopped containers removed"

# Remove dangling images
docker image prune -f 2>/dev/null && echo "  ✓ Dangling images removed"

# Remove old unused images (> 24 hours)
docker image prune -af --filter "until=24h" 2>/dev/null && echo "  ✓ Old images (>24h) removed"

# Remove build cache
docker builder prune -f --filter "until=12h" 2>/dev/null && echo "  ✓ Build cache (>12h) removed"

# Remove unused volumes
docker volume prune -f 2>/dev/null && echo "  ✓ Unused volumes removed"

echo ""
echo "  Docker disk usage after:"
docker system df 2>/dev/null | head -5 | sed 's/^/    /'

# ── 6. Kill stuck/failed K8s deployments ─────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[6/6] Cleaning failed K8s deployments..."

if command -v kubectl &>/dev/null; then
    # List pending pods (these are the ones generating log spam)
    PENDING=$(kubectl get pods -n sarthiq-apps --field-selector=status.phase=Pending --no-headers 2>/dev/null | wc -l)
    echo "  Pending pods in sarthiq-apps: $PENDING"

    if [ "$PENDING" -gt 0 ]; then
        echo "  Deleting pending pods to stop log spam..."
        kubectl delete pods -n sarthiq-apps --field-selector=status.phase=Pending 2>/dev/null
        echo "  ✓ Pending pods deleted"
    fi

    # Delete failed deployments with no ready replicas
    echo "  Checking for deployments with 0 ready replicas..."
    kubectl get deployments -n sarthiq-apps -o json 2>/dev/null | \
        python3 -c "
import sys, json
data = json.load(sys.stdin)
for d in data.get('items', []):
    name = d['metadata']['name']
    ready = d.get('status', {}).get('readyReplicas', 0) or 0
    avail = d.get('status', {}).get('availableReplicas', 0) or 0
    if ready == 0 and avail == 0:
        print(name)
" 2>/dev/null | while read deploy; do
        echo "  Deleting stale deployment: $deploy"
        kubectl delete deployment "$deploy" -n sarthiq-apps 2>/dev/null
    done

    echo "  ✓ Stale K8s resources cleaned"
else
    echo "  kubectl not found, skipping"
fi

# ── Final report ─────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ Emergency cleanup complete!                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "📊 Disk usage after cleanup:"
df -h /
echo ""
echo "📊 /var/log after cleanup:"
du -sh /var/log
echo ""
echo "⚡ Next steps:"
echo "  1. Fix CNI: Install loopback plugin to /opt/cni/bin"
echo "  2. Run: sudo bash scripts/setup-log-rotation.sh"
echo "  3. Restart: systemctl restart kubelet containerd"
echo "  4. Deploy your app code changes (queues.js, wakeWorker.js, etc.)"
