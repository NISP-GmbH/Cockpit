#!/usr/bin/env bash
# Cockpit launcher with auto-restart for macOS / Linux (mirrors Cockpit.cmd on Windows).
# Relaunches Cockpit whenever it closes. Press Ctrl+C or close this terminal to stop.
#
#   bash cockpit.sh            start - or, if Cockpit is already running, offer to restart it
#   bash cockpit.sh --restart  restart a running Cockpit without asking (e.g. after git pull)

cd "$(dirname "$0")" || exit 1

if [ ! -d node_modules/electron ]; then
  echo "Electron is not installed. Run:  npm install"
  exit 1
fi

trap 'echo; echo "Cockpit stopped."; exit 0' INT TERM

# Electron itself rather than `npm start`, so its exit code comes through as it is.
ELECTRON="./node_modules/.bin/electron"
[ -x "$ELECTRON" ] || ELECTRON="npx electron"

# Exit codes from main.js (see "single instance" there).
ALREADY_RUNNING=3      # another Cockpit is running; it has shown its window
RESTARTED_ELSEWHERE=4  # this Cockpit was quit because a newer start asked for a restart
NOTHING_TO_RESTART=5   # asked for a restart, but nothing was running

restart=0
[ "$1" = "--restart" ] && restart=1
waiting=0  # seconds left to wait for a running Cockpit that was asked to quit
quick=0    # starts in a row that closed almost at once

ask_restart() {
  [ -t 0 ] || return 1 # nobody to ask
  printf 'Restart it now, so it runs the current code? [y/N] '
  read -r -t 30 ans || { echo; return 1; }
  case "$ans" in [yY]*) return 0 ;; *) return 1 ;; esac
}

while true; do
  started=$SECONDS
  $ELECTRON .
  rc=$?

  if [ "$rc" -eq "$ALREADY_RUNNING" ]; then
    if [ "$waiting" -gt 0 ]; then
      # we asked it to quit: it sends any held mail first, so give it a moment
      waiting=$((waiting - 1))
      sleep 1
      continue
    fi
    echo
    echo "Cockpit is already running - its window has been brought to the front."
    if [ "$restart" = 1 ] || ask_restart; then
      restart=0
      echo "Asking it to quit (any held mail is sent first) ..."
      $ELECTRON . --restart-running >/dev/null 2>&1
      [ $? -eq "$NOTHING_TO_RESTART" ] || waiting=30
      continue
    fi
    echo "Not starting a second copy."
    exit 0
  fi
  waiting=0

  if [ "$rc" -eq "$RESTARTED_ELSEWHERE" ]; then
    echo
    echo "Cockpit was restarted from another window - this launcher stops here."
    exit 0
  fi

  # A Cockpit that dies right after starting (a broken install, a syntax error) would
  # otherwise be restarted every 2 s for ever, with nothing on screen to say why.
  if [ $((SECONDS - started)) -lt 5 ]; then quick=$((quick + 1)); else quick=0; fi
  if [ "$quick" -ge 3 ]; then
    echo
    echo "Cockpit closed right after starting, 3 times in a row - not restarting again."
    echo "Run  npm start  here to see what goes wrong."
    exit 1
  fi

  echo
  echo "App closed - restarting in 2 seconds.  Press Ctrl+C (or close this window) to stop."
  sleep 2
done
