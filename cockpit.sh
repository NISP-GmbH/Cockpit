#!/usr/bin/env bash
# Cockpit launcher with auto-restart for macOS / Linux (mirrors Cockpit.cmd on Windows).
# Relaunches Cockpit whenever it closes. Press Ctrl+C or close this terminal to stop.

cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules/electron ]; then
  echo "Electron is not installed. Run:  npm install"
  exit 1
fi

trap 'echo; echo "Cockpit stopped."; exit 0' INT TERM

while true; do
  npm start
  echo
  echo "App closed - restarting in 2 seconds.  Press Ctrl+C (or close this window) to stop."
  sleep 2
done
