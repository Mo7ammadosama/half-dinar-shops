#!/usr/bin/env bash
# Sabotage verification (8.4).
#
# Deliberately breaks each critical business rule, runs the test that is
# supposed to catch it, and reports whether it DID. A test that stays green
# while its rule is broken is worse than no test — it is a false guarantee.
#
# Every file is backed up before it is touched and restored immediately after,
# whether the test passes, fails, or the run dies.
set -u

cd "$(dirname "$0")"
JEST="npx cross-env NODE_OPTIONS=--experimental-vm-modules RATE_LIMIT_OTP_PER_PHONE_PER_HOUR=100000 npx jest --config ./test/jest-e2e.json --runInBand"
RESULTS=()

restore_all() {
  for f in $(find src prisma -name "*.sabotage-bak" 2>/dev/null); do
    mv "$f" "${f%.sabotage-bak}"
  done
}
trap restore_all EXIT

# sabotage <label> <file> <find> <replace> <test-pattern>
sabotage() {
  local label="$1" file="$2" find="$3" replace="$4" pattern="$5"

  cp "$file" "$file.sabotage-bak"
  # perl over sed: handles arbitrary punctuation in the patterns safely.
  perl -0pi -e "s/\Q$find\E/$replace/" "$file"

  if ! grep -qF "$replace" "$file"; then
    RESULTS+=("?? $label — SABOTAGE DID NOT APPLY (pattern not found; check the script)")
    mv "$file.sabotage-bak" "$file"
    return
  fi

  echo ""
  echo "--- SABOTAGING: $label"
  if $JEST -t "$pattern" > /tmp/sab.txt 2>&1; then
    RESULTS+=("XX $label — TESTS STILL PASSED. The rule is NOT protected.")
  else
    local failed
    failed=$(grep -cE "✕|●.*›.*›" /tmp/sab.txt 2>/dev/null | head -1)
    RESULTS+=("OK $label — caught (test failed as it should)")
  fi

  mv "$file.sabotage-bak" "$file"
}

# 1. THE APPROVED-ONLY RULE — customers must only ever see approved shops.
sabotage "approved-shops-only" \
  "src/common/merchant-visibility.ts" \
  'export const APPROVED_ONLY = { status: "APPROVED" } as const;' \
  'export const APPROVED_ONLY = {} as const;' \
  "Browsing|approved"

# 2. THE PRICE SNAPSHOT — price_at_order must never be recalculated.
sabotage "price snapshot" \
  "src/orders/orders.service.ts" \
  'priceAtOrder: product.price,' \
  'priceAtOrder: product.price.times(2),' \
  "snapshot"

# 3. CANCELLATION WINDOW — blocked once out for delivery.
sabotage "cancellation window (DELIVERING blocked)" \
  "src/orders/order-policy.ts" \
  'export const CUSTOMER_WARNED_CANCEL: readonly OrderStatus[] = ["CONFIRMED", "PREPARING"];' \
  'export const CUSTOMER_WARNED_CANCEL: readonly OrderStatus[] = ["CONFIRMED", "PREPARING", "DELIVERING"];' \
  "cancel"

# 4. MANDATORY CANCELLATION REASON — a merchant must say why.
#
# ⚠️ NOT SABOTAGEABLE FROM THIS SCRIPT, and that is a GOOD sign — this rule has
# DEFENCE IN DEPTH. It is guarded in two independent layers:
#
#   1. src/orders/dto.ts                    — @IsString + @Length(3, 500)
#   2. src/orders/merchant-orders.service.ts — if (trimmed.length === 0) throw
#
# Breaking either one alone does NOT break the rule; the other still catches it,
# and the tests stay green — correctly. Two earlier attempts here reported "the
# tests are a lie" when in fact the sabotage had simply failed to break
# anything.
#
# VERIFIED MANUALLY (Phase 8) by breaking BOTH layers at once — @Length(0,500)
# AND `if (false)` on the service guard. The test "requires a reason — an empty
# or missing one is refused" then failed immediately. The rule is protected.
#
# The single-file `sabotage` helper below cannot express a two-file break, so
# this is left as a documented manual check rather than a misleading automated
# one. To redo it:
#   perl -0pi -e 's/\@Length\(3, 500, \{/\@Length(0, 500, {/' src/orders/dto.ts
#   perl -0pi -e 's/if \(trimmed\.length === 0\) \{/if (false) {/' src/orders/merchant-orders.service.ts
#   npm run test:e2e -- -t "requires a reason"     # must FAIL
#   ...then restore both.

# 5. ROLE ISOLATION — one shop must never touch another's data.
sabotage "shop isolation (merchant scoping)" \
  "src/products/products.service.ts" \
  'where: { id, merchantId: merchant.id },' \
  'where: { id },' \
  "isolation|another shop"

# 6. THE ESCALATION RULE (new in Phase 8) — an ignored order must escalate.
sabotage "escalation of ignored orders" \
  "src/orders/escalation-policy.ts" \
  'if (elapsedSeconds >= ESCALATION.adminAlertSeconds) return 2;' \
  'if (false) return 2;' \
  "escalation|Ignored-order"

# 7. PHONE GATING (found + fixed in 8.3) — the shop must not keep the number.
sabotage "customer phone gating (the 8.3 finding)" \
  "src/orders/merchant-orders.service.ts" \
  'phoneNumber: SHOP_CONTACT_WINDOW.includes(order.status)' \
  'phoneNumber: true || SHOP_CONTACT_WINDOW.includes(order.status)' \
  "harvest|phone number is withheld"

echo ""
echo "==================== SABOTAGE RESULTS ===================="
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo "========================================================="
echo ""
echo "OK = the rule is genuinely protected (breaking it fails a test)"
echo "XX = THE TEST IS A LIE (rule broken, tests still green)"
