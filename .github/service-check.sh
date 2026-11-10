#!/bin/bash
# service-check.sh runs a real dakort setup on macOS (a launchd agent) or
# Linux (a systemd user unit): a first install into a folder with a space
# in its name, the hot-path update with a staged build, the cold-path
# reinstall over a running service, the uninstall, and the fallback that
# starts the server directly when the install fails. Throwaway name
# (dakort-test), folder and ports (3005, 13005). The macOS and Linux
# counterpart of TestRealSetup (cmd/dakort/setup_windows_test.go); CI runs
# it on both (ci.yml, the service job), since the real CLIs are not needed
# for the service part.
#
#   .github/service-check.sh            builds the two test binaries here (needs go)
#   .github/service-check.sh <dir>      uses <dir>/dakort-test1 and <dir>/dakort-test2
#
# It lives under .github rather than scripts/ because scripts/ is kept out
# of the public repo, where CI runs it.
#
# The second form is for a box without Go, such as WSL driven from Windows:
#   GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-X main.version=test1" -o <dir>/dakort-test1 ./cmd/dakort
#   (the same with test2), then
#   wsl -d Ubuntu -- bash /mnt/c/<repo>/.github/service-check.sh /mnt/c/<dir>
#
# First run 2026-11-09 under WSL2 Ubuntu: it found the unit's WorkingDirectory
# written in quotes, which systemd refuses ("path is not absolute").
set -u
WORK=$(mktemp -d /tmp/madetest-XXXXXX)
if [ $# -ge 1 ]; then
  cp "$1/dakort-test1" "$WORK/dakort1" && cp "$1/dakort-test2" "$WORK/dakort2" || exit 1
  chmod +x "$WORK/dakort1" "$WORK/dakort2"
else
  cd "$(dirname "$0")/.." || exit 1
  go build -ldflags "-X main.version=test1" -o "$WORK/dakort1" ./cmd/dakort || exit 1
  go build -ldflags "-X main.version=test2" -o "$WORK/dakort2" ./cmd/dakort || exit 1
fi
HOME_DIR="$WORK/madetest-setup dir"
DATA="$HOME_DIR/data"
NAME=dakort-test
PORT=3005
case "$(uname)" in
  Darwin)
    DEF=~/Library/LaunchAgents/$NAME.plist
    active() { launchctl print "gui/$(id -u)/$NAME" >/dev/null 2>&1; }
    restarted() { true; } # launchd keeps no journal; the log's "dakort test2" line is the proof
    ;;
  *)
    DEF=~/.config/systemd/user/$NAME.service
    active() { systemctl --user is-active --quiet $NAME; }
    restarted() { journalctl --user -u $NAME --no-pager | grep -q 'status=75'; }
    ;;
esac
if [ -e "$DEF" ]; then echo "$DEF exists already; remove it first"; exit 1; fi
COMMON=(setup -name $NAME -home "$HOME_DIR" -data "$DATA" -port $PORT -no-browser)
COLD=(setup -name $NAME -home "$HOME_DIR" -data "$DATA" -port 1$PORT -no-browser)
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
answering() { curl -s -o /dev/null -m 2 "http://127.0.0.1:$1/"; }
waitup() { for i in $(seq 40); do answering "$1" && return 0; sleep 0.5; done; return 1; }
waitdown() { for i in $(seq 40); do answering "$1" || return 0; sleep 0.5; done; return 1; }
servers() { pgrep -f "^$HOME_DIR/bin/dakort " | wc -l | tr -d ' '; }

echo "== work: $WORK on $(uname)"

echo "== 1. cold path, first install"
out=$("$WORK/dakort1" "${COMMON[@]}" 2>&1); echo "$out"
check "install says it starts at login" "echo \"\$out\" | grep -q 'it starts'"
check "install says test1 runs as $NAME" "echo \"\$out\" | grep -q 'dakort test1 runs as $NAME'"
check "install prints a login link" "echo \"\$out\" | grep -q '/login?token='"
check "answering on $PORT" "waitup $PORT"
check "the service manager says active" "active"
check "definition exists" "test -f $DEF"
echo "-- definition:"; grep -v 'PATH=\|^Environment=' "$DEF"
check "token written" "test -s \"$DATA/token\""
tok=$(cat "$DATA/token")
code=$(curl -s -o /dev/null -w '%{http_code}' -b "dakort_token=$tok" "http://127.0.0.1:$PORT/api/sessions")
check "sessions with the token (got $code)" "test $code = 200"
check "one server from the install folder ($(servers))" "test $(servers) = 1"

echo "== 2. hot path, a staged build"
out=$("$WORK/dakort2" "${COMMON[@]}" 2>&1); echo "$out"
check "update says restarted with test2" "echo \"\$out\" | grep -q 'restarted with test2'"
check "staged file swapped in" "test ! -e \"$HOME_DIR/bin/dakort.new\""
check "installed binary says test2" "\"$HOME_DIR/bin/dakort\" -version | grep -q test2"
check "the service manager saw the 75 exit" "restarted"
check "log has dakort test2" "grep -q 'dakort test2' \"$HOME_DIR/logs/server.log\""
check "still answering" "waitup $PORT"
check "one server ($(servers))" "test $(servers) = 1"

echo "== 3. the installed binary's own setup stages nothing"
out=$("$HOME_DIR/bin/dakort" "${COMMON[@]}" 2>&1); echo "$out"
check "says running this build" "echo \"\$out\" | grep -q 'is running this build'"

echo "== 4. cold path over a running service (new port)"
out=$("$WORK/dakort2" "${COLD[@]}" 2>&1); echo "$out"
check "reinstall says it starts at login" "echo \"\$out\" | grep -q 'it starts'"
check "new port answers" "waitup 1$PORT"
check "old port silent" "waitdown $PORT"
check "one server ($(servers))" "test $(servers) = 1"

echo "== 5. uninstall"
out=$("$WORK/dakort2" "${COLD[@]}" -uninstall 2>&1); echo "$out"
check "definition removed" "test ! -e $DEF"
check "not active" "! active"
check "port silent" "waitdown 1$PORT"
check "no server ($(servers))" "test $(servers) = 0"
check "files stay" "test -s \"$DATA/token\" && test -x \"$HOME_DIR/bin/dakort\""

echo "== 6. the fallback when the install fails (the definition's path is a directory, so it cannot be written)"
mkdir -p "$DEF"
out=$("$WORK/dakort2" "${COLD[@]}" 2>&1); rc=$?; echo "$out"
check "setup exits non-zero ($rc)" "test $rc != 0"
check "says could not be installed" "echo \"\$out\" | grep -q 'could not be installed'"
check "says starting directly" "echo \"\$out\" | grep -q 'Starting the server directly'"
check "still prints the login link" "echo \"\$out\" | grep -q '/login?token='"
check "answering on 1$PORT" "waitup 1$PORT"
check "one server, detached ($(servers))" "test $(servers) = 1"
rmdir "$DEF"
echo "-- a setup that works again takes the detached server over"
out=$("$WORK/dakort2" "${COLD[@]}" 2>&1); echo "$out"
check "reinstall says it starts at login" "echo \"\$out\" | grep -q 'it starts'"
check "answering on 1$PORT" "waitup 1$PORT"
check "one server ($(servers))" "test $(servers) = 1"
check "the service manager says active" "active"
out=$("$WORK/dakort2" "${COLD[@]}" -uninstall 2>&1); echo "$out"
check "port silent" "waitdown 1$PORT"
check "no server ($(servers))" "test $(servers) = 0"
check "definition removed" "test ! -e $DEF"

echo "== result: fail=$fail"
case "$WORK" in /tmp/madetest-*) rm -rf "$WORK" ;; esac
exit $fail
