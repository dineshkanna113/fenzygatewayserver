#!/usr/bin/env bash
# Boots the image and checks the endpoints a deploy depends on.
# Usage: scripts/smoke-test.sh <image> [port]
set -euo pipefail

IMAGE="${1:?usage: smoke-test.sh <image> [port]}"
PORT="${2:-4555}"
NAME="mockgw-smoke-$$"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  if [ "${status:-0}" -ne 0 ]; then docker logs "$NAME" || true; fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap 'status=$?; cleanup' EXIT

docker run -d --name "$NAME" -p "${PORT}:4000" \
  -e ADMIN_PASSWORD=smoke-test-password \
  -e ADMIN_API_TOKEN=smoke-token \
  -e PUBLIC_URL="$BASE" \
  "$IMAGE" >/dev/null

for i in $(seq 1 30); do
  if curl -fsS "$BASE/health" >/dev/null 2>&1; then break; fi
  [ "$i" -eq 30 ] && { echo "server did not become healthy"; exit 1; }
  sleep 1
done

check() { # name, expected status, curl args...
  local name="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" != "$want" ]; then echo "FAIL $name: expected $want, got $got"; exit 1; fi
  echo "ok   $name ($got)"
}

curl -fsS "$BASE/health"; echo
check "login page"            200 "$BASE/login"
check "dashboard needs auth"  401 "$BASE/api/stats"
check "admin api with token"  200 -H "Authorization: Bearer smoke-token" "$BASE/api/stats"
check "razorpay order"        200 -u rzp_test_mockkey000001:mock_razorpay_secret -H 'Content-Type: application/json' -d '{"amount":10000}' "$BASE/razorpay/v1/orders"
check "stripe intent"         200 -u sk_test_mock_stripe_secret: -d amount=1000 -d currency=inr -d payment_method=pm_card_visa -d confirm=true "$BASE/v1/payment_intents"
check "twilio sms"            201 -u ACmock00000000000000000000000000:mock_twilio_auth_token --data-urlencode 'To=+919876543210' --data-urlencode 'From=+15005550006' -d 'Body=Your OTP is 123456' "$BASE/twilio/2010-04-01/Accounts/ACmock00000000000000000000000000/Messages.json"
check "sendgrid email"        202 -H 'Authorization: Bearer SG.mock_sendgrid_api_key' -H 'Content-Type: application/json' -d '{"personalizations":[{"to":[{"email":"a@b.test"}]}],"from":{"email":"x@b.test"},"subject":"Hi","content":[{"type":"text/plain","value":"code 654321"}]}' "$BASE/sendgrid/v3/mail/send"
check "otp captured"          200 -H "Authorization: Bearer smoke-token" "$BASE/api/sms/latest?to=9876543210"
check "checkout sdk"          200 "$BASE/razorpay/v1/checkout.js"
echo "smoke test passed"
