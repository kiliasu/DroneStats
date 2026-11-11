#!/usr/bin/env bash
# Installs DroneStats in one command: a Python environment beside the code, and a systemd service that
# starts it at boot. Run it again with other options to change them, or with --uninstall to remove the
# service. Nothing outside this folder changes except the unit files and their state directory.
#
#   ./install.sh                                  real flight controller through mavlink-router on 5678
#   ./install.sh --mavlink 127.0.0.1:5760         any other MAVLink TCP endpoint
#   ./install.sh --listen 0.0.0.0:8080            reachable from the local network too
#   ./install.sh --sitl ~/ardupilot               a simulated aircraft of its own, labelled as such
#   ./install.sh --user                           a per-user service, with no root
#   ./install.sh --no-service                     only the environment; run it by hand
set -euo pipefail

DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
cd "$DIR"

MAVLINK=127.0.0.1:5678
LISTEN=127.0.0.1:8080
BAUD=57600
CELLS=""
SCOPE=system            # system | user | none
ARDUPILOT=""
SITL_INSTANCE=2
SITL_HOME="-35.363261,149.165230,584,353"   # ArduPilot's own default: Canberra Model Aircraft Club
ALLOW=()
UNINSTALL=0
MAVLINK_GIVEN=0

usage() {
  cat <<EOF
Usage: ./install.sh [options]

  --mavlink HOST:PORT   MAVLink TCP endpoint to read (default $MAVLINK, mavlink-router's)
  --listen ADDR:PORT    address for the page (default $LISTEN: this computer only)
  --allow-host NAME     another name the page may be opened by, such as drone.example.com (repeatable)
  --cells N             battery cells in series (default 2, or 3 with --sitl)
  --baud N              speed of the serial link to the flight controller, for link load (default $BAUD)
  --sitl DIR            also run an ArduCopter SITL built in this ArduPilot checkout, and read it
  --sitl-home LAT,LON,ALT,HEADING   where the simulated aircraft starts (default $SITL_HOME)
  --sitl-instance N     SITL instance, which sets its ports: 5760 + 10 x N (default $SITL_INSTANCE)
  --user                install as a per-user service (no root; see the note on lingering)
  --no-service          only set up the Python environment
  --uninstall           stop and remove the services; keeps the code, the environment and the marks
  -h, --help            this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mavlink) MAVLINK=$2; MAVLINK_GIVEN=1; shift 2 ;;
    --listen) LISTEN=$2; shift 2 ;;
    --allow-host) ALLOW+=("$2"); shift 2 ;;
    --cells) CELLS=$2; shift 2 ;;
    --baud) BAUD=$2; shift 2 ;;
    --sitl) ARDUPILOT=$(cd "$2" && pwd); shift 2 ;;
    --sitl-home) SITL_HOME=$2; shift 2 ;;
    --sitl-instance) SITL_INSTANCE=$2; shift 2 ;;
    --user) SCOPE=user; shift ;;
    --no-service) SCOPE=none; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# ---- Uninstall --------------------------------------------------------------------------------------

if [ "$UNINSTALL" = 1 ]; then
  ROOT=""
  [ "$(id -u)" -ne 0 ] && ROOT=sudo
  USER_UNITS=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  for unit in dronestats dronestats-sitl; do
    if [ -f "/etc/systemd/system/$unit.service" ]; then
      say "Removing the system service $unit"
      $ROOT systemctl disable --now "$unit" 2>/dev/null || true
      $ROOT rm -f "/etc/systemd/system/$unit.service"
      $ROOT systemctl daemon-reload
    fi
    if [ -f "$USER_UNITS/$unit.service" ]; then
      say "Removing the per-user service $unit"
      systemctl --user disable --now "$unit" 2>/dev/null || true
      rm -f "$USER_UNITS/$unit.service"
      systemctl --user daemon-reload
    fi
  done
  say "Done. The code, .venv and any marks are left in place."
  exit 0
fi

SUDO=""
if [ "$SCOPE" = system ] && [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null || die "a system service needs root or sudo; try --user"
  SUDO=sudo
fi
UNIT_DIR=/etc/systemd/system
CTL=($SUDO systemctl)
if [ "$SCOPE" = user ]; then
  UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  CTL=(systemctl --user)
fi

# ---- Python -----------------------------------------------------------------------------------------

# 3.11 or newer: before that, `except TimeoutError` does not catch asyncio.wait_for's timeout.
python_ok() { "$1" -c 'import sys, venv, ensurepip; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; }
PY=""
for candidate in python3.14 python3.13 python3.12 python3.11 python3; do
  if command -v "$candidate" >/dev/null && python_ok "$candidate"; then PY=$(command -v "$candidate"); break; fi
done

if [ -x .venv/bin/python ] && ! .venv/bin/python -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then
  say "The existing .venv is older than Python 3.11: making a new one"
  rm -rf .venv
fi
if [ ! -x .venv/bin/python ]; then
  if [ -n "$PY" ]; then
    say "Making .venv with $($PY --version)"
    "$PY" -m venv .venv
  elif command -v uv >/dev/null; then
    say "No Python 3.11+ with venv here: making .venv with uv"
    uv venv --python 3.12 .venv
  else
    die "needs Python 3.11 or newer with venv (for example: sudo apt install python3.12-venv), or uv"
  fi
fi
say "Installing Python packages"
if [ -x .venv/bin/pip ]; then
  .venv/bin/pip install --quiet --disable-pip-version-check -r requirements.txt
else
  uv pip install --quiet --python .venv/bin/python -r requirements.txt
fi
PY=$DIR/.venv/bin/python

# ---- What the service runs --------------------------------------------------------------------------

if [ -n "$ARDUPILOT" ]; then
  [ -x "$ARDUPILOT/build/sitl/bin/arducopter" ] || die "no SITL build at $ARDUPILOT/build/sitl/bin/arducopter (./waf configure --board sitl && ./waf copter)"
  [ "$MAVLINK_GIVEN" = 1 ] || MAVLINK=127.0.0.1:$((5760 + 10 * SITL_INSTANCE))
  CELLS=${CELLS:-3}       # SITL's battery is a 3S pack
fi
ARGS="--listen $LISTEN --mavlink $MAVLINK --baud $BAUD --cells ${CELLS:-2}"
[ -n "$ARDUPILOT" ] && ARGS+=" --simulator"
for name in "${ALLOW[@]+"${ALLOW[@]}"}"; do ARGS+=" --allow-host $name"; done

if [ "$SCOPE" = none ]; then
  say "Ready. Start it with:"
  echo "  cd $DIR && .venv/bin/python server.py $ARGS"
  exit 0
fi
command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "systemd is not running here; use --no-service and start it by hand"

# Fills in a template. Per-user units cannot set a user or use the kernel and address-family limits.
render() {
  TEMPLATE=$1 SCOPE=$SCOPE "$PY" - <<'EOF'
import os, re
text = open(os.environ["TEMPLATE"], encoding="utf-8").read()
for key in ("USER", "GROUP", "DIR", "ARGS", "AFTER", "WANTED_BY", "ARDUPILOT", "SITL_DIR", "SITL_INSTANCE", "SITL_HOME"):
    text = text.replace(f"@{key}@", os.environ.get(f"R_{key}", ""))
if os.environ["SCOPE"] == "user":
    text = re.sub(r"(?m)^(User|Group|ProtectKernelTunables|ProtectKernelModules|ProtectControlGroups|RestrictAddressFamilies)=.*\n", "", text)
print(text, end="")
EOF
}

export R_USER=$(id -un) R_GROUP=$(id -gn) R_DIR=$DIR R_ARGS=$ARGS R_ARDUPILOT=$ARDUPILOT R_SITL_INSTANCE=$SITL_INSTANCE R_SITL_HOME=$SITL_HOME
export R_WANTED_BY=$([ "$SCOPE" = user ] && echo default.target || echo multi-user.target)
export R_SITL_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/dronestats-sitl
export R_AFTER=$([ -n "$ARDUPILOT" ] && echo dronestats-sitl.service || true)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
UNITS=(dronestats)
render deploy/dronestats.service.in > "$TMP/dronestats.service"
if [ -n "$ARDUPILOT" ]; then
  mkdir -p "$R_SITL_DIR"
  render deploy/dronestats-sitl.service.in > "$TMP/dronestats-sitl.service"
  UNITS=(dronestats-sitl dronestats)
fi

say "Installing ${UNITS[*]} as $SCOPE service$([ ${#UNITS[@]} -gt 1 ] && echo s) in $UNIT_DIR"
if [ "$SCOPE" = user ]; then
  mkdir -p "$UNIT_DIR"
  for unit in "${UNITS[@]}"; do install -m 644 "$TMP/$unit.service" "$UNIT_DIR/"; done
else
  for unit in "${UNITS[@]}"; do $SUDO install -m 644 "$TMP/$unit.service" "$UNIT_DIR/"; done
fi
"${CTL[@]}" daemon-reload
for unit in "${UNITS[@]}"; do
  "${CTL[@]}" enable --quiet "$unit" || echo "  Could not enable $unit: it will not start at boot."
  "${CTL[@]}" restart "$unit"
done

sleep 2
"${CTL[@]}" is-active --quiet dronestats || die "the service did not start; see: journalctl $([ "$SCOPE" = user ] && echo --user-unit || echo -u) dronestats"

say "DroneStats is running."
HOST=${LISTEN%:*}; PORT=${LISTEN##*:}
case "$HOST" in
  127.0.0.1|localhost|"[::1]") echo "  Open http://127.0.0.1:$PORT/ on this computer, or through Tailscale on its tailnet name." ;;
  0.0.0.0|"[::]") echo "  Open http://<this computer's address>:$PORT/ from any device that can reach it." ;;
  *) echo "  Open http://$HOST:$PORT/" ;;
esac
case "$HOST" in
  127.0.0.1|localhost|"[::1]") ;;
  *) echo "  Note: any device that can open the page can turn on execution and command the aircraft." ;;
esac
[ -n "$ARDUPILOT" ] && echo "  The simulator's ground station port: TCP $((5762 + 10 * SITL_INSTANCE))."

# The parts of this computer the README asks for that live outside this folder. None of them stops the
# install: the page works without them, and the router may not be up yet. They are checked so that a
# new computer missing one says so now, rather than as an empty reading on the page later.
if [ -z "$ARDUPILOT" ] && ! "$PY" -c 'import socket, sys; h, p = sys.argv[1].rsplit(":", 1); socket.create_connection((h, int(p)), 2).close()' "$MAVLINK" 2>/dev/null; then
  echo "  Nothing answers on $MAVLINK yet: is mavlink-router running, with TcpServerPort = ${MAVLINK##*:}?"
fi
command -v iw >/dev/null || [ -x /usr/sbin/iw ] || [ -x /sbin/iw ] || echo "  iw is not installed, so the page has no Wi-Fi reading: sudo apt install iw"
case "$HOST" in
  127.0.0.1|localhost|"[::1]")
    if [ ! -S /run/tailscale/tailscaled.sock ]; then
      echo "  Tailscale is not running, so the page opens on this computer only."
    elif [ -e /sys/class/net/tailscale0 ]; then
      # Only userspace networking delivers tailnet connections over loopback; with an interface they
      # arrive at the Tailscale address, which a page on $LISTEN does not listen on.
      echo "  Tailscale is not in userspace networking mode, so the tailnet cannot reach $LISTEN (see the README)."
    fi ;;
esac
if [ "$SCOPE" = user ] && ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
  echo "  A per-user service stops when you log out. To keep it running and start it at boot:"
  echo "    sudo loginctl enable-linger $(id -un)"
fi
echo "  Logs: journalctl $([ "$SCOPE" = user ] && echo --user-unit || echo -u) dronestats -f"
