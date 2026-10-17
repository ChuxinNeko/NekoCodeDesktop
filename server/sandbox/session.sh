#!/bin/sh
set -eu
export HOME=/home/neko DISPLAY=:1 XDG_RUNTIME_DIR=/tmp/runtime-neko
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/neko-session-bus
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# Xvnc supplies RandR resize modes and keeps its X and RFB sockets inside the sandbox.
Xtigervnc :1 -geometry 1280x800 -depth 24 -rfbport 5900 -localhost yes \
  -SecurityTypes None -AlwaysShared -nolisten tcp -ac > /tmp/vnc.log 2>&1 &
vnc=$!
trap 'kill "$vnc" 2>/dev/null || true' EXIT
for n in $(seq 1 50); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
  kill -0 "$vnc"
  sleep 0.2
done
xdpyinfo -display :1 >/dev/null
xfce4-session > /tmp/xfce.log 2>&1 &
desktop=$!
# Activate AT-SPI on the same D-Bus session used by the desktop and future tools.
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
  --method org.a11y.Bus.GetAddress >/dev/null
touch /tmp/neko-desktop-ready
wait "$desktop"
