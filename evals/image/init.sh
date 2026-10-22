#!/bin/sh
# PID 1 for the sandbox toolchain image — mirrors the hub base images'
# /init.sh (heyo/alpine, heyo/debian, heyo/ubuntu; Apache-2.0, Heyo
# Web Services), because the kernel boots a deployment's rootfs via
# `init=/init.sh`. No systemd: this script sets up /dev and the network,
# mounts a data disk at /workspace, starts sshd (the `heyvm exec` channel),
# prints HEYVM_READY, and never exits.
#
# Nothing else is started here. A deployment's own process comes from app-lb's
# start_command, which is the only channel that carries env_vars.
#
# POSIX sh, because alpine has no bash in /bin/sh.

mount -t proc proc /proc
mount -t sysfs sysfs /sys

# Populate /dev via devtmpfs. A docker-exported rootfs has an empty /dev, so
# sshd would fail without device nodes. Fall back to manual mknod.
mount -t devtmpfs devtmpfs /dev 2>/dev/null
if [ ! -c /dev/null ]; then
    echo "init: devtmpfs unavailable, creating device nodes manually"
    mknod -m 666 /dev/null    c 1 3
    mknod -m 666 /dev/zero    c 1 5
    mknod -m 444 /dev/random  c 1 8
    mknod -m 444 /dev/urandom c 1 9
    mknod -m 666 /dev/tty     c 5 0
    mknod -m 666 /dev/ptmx    c 5 2
    ln -sf /proc/self/fd /dev/fd
fi
mkdir -p /dev/pts && mount -t devpts devpts /dev/pts

dmesg -n 1 2>/dev/null
echo "nameserver 8.8.8.8" > /etc/resolv.conf
hostname "$(cat /etc/heyo-hostname 2>/dev/null || echo heyo)"

# Network: the kernel ip= param may not be fully applied before init runs.
ip link set eth0 up 2>/dev/null
if ! ip addr show eth0 2>/dev/null | grep -q "inet "; then
    for param in $(cat /proc/cmdline); do
        case "$param" in
            ip=*)
                GUEST_IP="${param#ip=}"; GUEST_IP="${GUEST_IP%%::*}"
                TAIL="${param#*::}"; GW="${TAIL%%:*}"
                ip addr add "$GUEST_IP/30" dev eth0 2>/dev/null
                [ -n "$GW" ] && ip route add default via "$GW" dev eth0 2>/dev/null
                ;;
        esac
    done
fi

# /dev/vdb is one of two things, and only one of them is ours to mount:
# a persistent data disk (vm.disk_size_gb — format on first boot, reuse later)
# or a heyvmd guest mount (vm.workspace / mounts[] — labelled mount<N> and
# mounted by heyvmd itself after HEYVM_READY; mounting it here broke that).
if [ -b /dev/vdb ]; then
    label="$(blkid -s LABEL -o value /dev/vdb 2>/dev/null || true)"
    case "$label" in
        mount[0-9]*)
            echo "init: /dev/vdb is a heyvmd guest mount ($label); leaving it for heyvmd to mount at /workspace"
            ;;
        *)
            if ! blkid /dev/vdb >/dev/null 2>&1; then
                echo "init: formatting blank data disk /dev/vdb"
                mkfs.ext4 -q -L workspace /dev/vdb
            fi
            mkdir -p /workspace
            mount /dev/vdb /workspace 2>/dev/null
            ;;
    esac
fi
# Without /dev/vdb, /workspace is on the rootfs and does not survive a cold boot.
mkdir -p /workspace

# Package managers default to the small rootfs for caches and installs — that
# fills it up on real repos. /workspace is the data disk (disk_size_gb) and
# survives stops: point caches, user installs, and tmp at it.
mkdir -p /workspace/.cache/pip /workspace/.npm /workspace/.local /workspace/tmp
{
    echo "PIP_CACHE_DIR=/workspace/.cache/pip"
    echo "PYTHONUSERBASE=/workspace/.local"
    echo "PIP_USER=1"
    echo "NPM_CONFIG_CACHE=/workspace/.npm"
    echo "TMPDIR=/workspace/tmp"
} >> /etc/environment
cat > /etc/profile.d/workspace-env.sh <<'EOF'
export PIP_CACHE_DIR=/workspace/.cache/pip
export PYTHONUSERBASE=/workspace/.local
export PIP_USER=1
export NPM_CONFIG_CACHE=/workspace/.npm
export TMPDIR=/workspace/tmp
export PATH="$PATH:/workspace/.local/bin"
EOF

# sshd for `heyvm exec` / `heyvm sh`. Log to a file, never to the serial
# console, which carries the marker-delimited command protocol.
mkdir -p /run/sshd
chown root:root /run/sshd
chmod 755 /run/sshd
chown root:root /etc/ssh/ssh_host_* 2>/dev/null
chmod 600 /etc/ssh/ssh_host_*_key 2>/dev/null
chmod 644 /etc/ssh/ssh_host_*_key.pub 2>/dev/null
/usr/sbin/sshd -D -e 2>/tmp/sshd.log &

echo "HEYVM_READY"

# Keep PID 1 alive with an interactive shell for `heyvm sh`. The loop survives
# the user exiting the shell (a PID 1 exit would panic the kernel).
while :; do /bin/bash --login; sleep 0.1; done
