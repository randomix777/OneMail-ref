#!/usr/bin/env bash
# Smoke-test a running OneMail deployment.
#
#   ./verify.sh                                   # https://onemail.jyisolutions.com
#   ./verify.sh http://127.0.0.1:3000             # local / pre-DNS check
set -euo pipefail

base="${1:-https://onemail.jyisolutions.com}"
base="${base%/}"
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf 'ok    %-28s %s\n' "$label" "$actual"
  else
    printf 'FAIL  %-28s expected %s, got %s\n' "$label" "$expected" "$actual"
    fail=1
  fi
}

health="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base/api/health")"
check "GET /api/health" 200 "$health"

login="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$base/login")"
check "GET /login" 200 "$login"

start="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  "$base/api/auth/firebase/start?callbackURL=%2Fwelcome-redirect")"
check "GET firebase/start" 302 "$start"

location="$(curl -s -o /dev/null -D - --max-time 20 \
  "$base/api/auth/firebase/start?callbackURL=%2Fwelcome-redirect" \
  | tr -d '\r' | awk 'tolower($1) == "location:" { print $2 }')"

case "$location" in
  https://account.jyisolutions.com/firebase-sign-in\?*client_id=onemail-web*)
    printf 'ok    %-28s %s\n' "redirect target" "account centre / onemail-web"
    ;;
  *)
    printf 'FAIL  %-28s %s\n' "redirect target" "${location:-<empty>}"
    fail=1
    ;;
esac

if [ "$fail" -eq 0 ]; then
  echo "all checks passed"
else
  echo "one or more checks failed" >&2
fi
exit "$fail"
