#!/usr/bin/env bash
# Prints what this computer has of the environment DroneStats is deployed in (the README's "Reference
# environment"), to compare two computers or to fill in that table. It only reads, and needs no root.
# It leaves out what identifies the computer or its networks: host and tailnet names, addresses other
# than loopback, Wi-Fi names, user names, so the output can be shared.
#
#   tools/env_report.sh
set -uo pipefail
PATH=$PATH:/usr/sbin:/sbin
DIR=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
VENV=$DIR/.venv/bin/python

row() { printf '%-20s %s\n' "$1" "${2:-(none)}"; }
first() { "$@" 2>/dev/null | head -n 1; }
# IPv4 addresses other than loopback and "any" become <address>.
mask() { sed -E 's/127\.0\.0\.1/@LOOP@/g; s/0\.0\.0\.0/@ANY@/g; s/([0-9]{1,3}\.){3}[0-9]{1,3}/<address>/g; s/@LOOP@/127.0.0.1/g; s/@ANY@/0.0.0.0/g'; }
# The command line a unit runs. unit_args SCOPE NAME, where SCOPE is "" or --user.
unit_args() { systemctl $1 show -p ExecStart --value "$2" 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\) ;.*/\1/p'; }

echo "DroneStats environment report, $(date -u +%Y-%m-%d)"
echo
# Orange Pi's kernels may name only the chip here (sun60iw2); their release file names the board.
board_name=$(sed -n 's/^BOARD_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/orangepi-release 2>/dev/null)
row "Board" "${board_name:+$board_name, }$(cat /proc/device-tree/model 2>/dev/null | tr -d '\0')"
row "Memory" "$(awk '/^MemTotal:/ { printf "%.1f GiB", $2 / 1048576 }' /proc/meminfo 2>/dev/null)"
row "Overlays" "$(sed -n 's/^overlays=//p' /boot/orangepiEnv.txt 2>/dev/null)"
row "Architecture" "$(uname -m)"
row "Kernel" "$(uname -r)"
row "OS" "$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-}")"
for release in /etc/orangepi-release /etc/armbian-release; do
  [ -r "$release" ] && row "${release#/etc/}" "$(grep -E '^(BOARD|BOARD_NAME|VERSION|BRANCH|DISTRIBUTION_CODENAME)=' "$release" | tr '\n' ' ')"
done
row "systemd" "$(first systemctl --version)"
row "Python" "$(first python3 --version)"

echo
row "DroneStats" "$(git -C "$DIR" describe --always --dirty 2>/dev/null)"
row ".venv" "$(first "$VENV" --version)"
row "Packages" "$("$VENV" -c 'import importlib.metadata as m; print(" ".join(sorted(f"{d.name}=={d.version}" for d in m.distributions() if d.name not in ("pip", "setuptools"))))' 2>/dev/null)"
for scope in "" --user; do
  systemctl $scope cat dronestats >/dev/null 2>&1 || continue
  row "Service${scope:+ ($scope)}" "$(systemctl $scope is-active dronestats 2>/dev/null), $(systemctl $scope is-enabled dronestats 2>/dev/null)"
  row "  arguments" "$(unit_args "$scope" dronestats | sed -E 's#^[^ ]*/\.venv/bin/python server\.py ?##; s/(--allow-host )[^ ]+/\1<name>/g' | mask)"
done

echo
if command -v mavlink-routerd >/dev/null; then
  row "mavlink-router" "$(first mavlink-routerd --version), $(systemctl is-active mavlink-router 2>/dev/null)"
  arguments=$(unit_args "" mavlink-router | sed -E 's#^[^ ]*mavlink-routerd ?##' | mask)
  [ -n "$arguments" ] && row "  arguments" "$arguments"
  for conf in /etc/mavlink-router/main.conf /etc/mavlink-router/config.d/*.conf; do
    [ -r "$conf" ] || continue
    echo "  $conf"
    grep -vE '^[[:space:]]*([#;]|$)' "$conf" | mask | sed 's/^/      /'
  done
else
  row "mavlink-router" "not installed"
fi
firewall=$(systemctl is-enabled mavlink-lan-block 2>/dev/null)
[ "$firewall" = not-found ] && firewall=""
row "Firewall unit" "mavlink-lan-block: ${firewall:-not installed}"
if [ -S /run/tailscale/tailscaled.sock ]; then
  row "Tailscale" "$(first tailscale version), $([ -e /sys/class/net/tailscale0 ] && echo 'with an interface (not userspace)' || echo 'userspace networking')"
else
  row "Tailscale" "not running"
fi
row "iw" "$(first iw --version)"
