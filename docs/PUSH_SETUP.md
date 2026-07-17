# Notifying customers on a closed phone (closing blocker B6)

**The problem this fixes:** the customer app has to be **open** for the customer to learn anything.
If the shop cancels their order, the app records it correctly and shows them the reason and the
outcome — **the moment they next open it.** Which might be an hour later, still waiting for shopping
that is never coming.

The app is **fully built and wired for push**. No code needs to change. This one takes about
20 minutes, and **most of it can only be finished by you** — see the honest limits at the bottom.

---

## Why this one has no "refuses to boot" guard (unlike SMS and storage)

The SMS and storage blockers stop production booting when unconfigured, because without them nobody
can log in at all, and photos are silently destroyed.

Push is different: **the pilot genuinely works without it.** The cost is that a customer must open
the app to see an update — which is exactly B6 — not that the product breaks. Refusing to boot over
that would be a worse trade. So instead it logs loudly on every startup:

```
[PushModule] Push notifications: console — customers will NOT be notified on a
closed phone (launch blocker B6). See docs/PUSH_SETUP.md to go live.
```

---

## Which provider I chose, and why

**Expo's push service.** This is close to a forced move, and a good one:

- The app is **already an Expo app**. Expo's service takes one API call and fans out to **both**
  FCM (Android) and APNs (iOS) — so there is no per-platform code in this backend, and **no Apple or
  Google server credentials to store here at all**.
- It is **free**.
- Going direct to FCM/APNs would mean managing an Apple push certificate (which expires annually),
  a Google service account, and two separate code paths — for no benefit at this size.

The code is behind the `PushSender` interface, so moving to raw FCM later is one new class.

---

## What you need to do

### Step 1 — Create an Expo account and link the project

1. Sign up (free) at <https://expo.dev/signup>.
2. From `mobile/`, run:
   ```bash
   npx expo login
   npx eas init
   ```
3. `eas init` creates a project on Expo's servers and writes a **`projectId`** into `mobile/app.json`.

> ⚠️ **This step is not optional and cannot be skipped.** Without a `projectId` in the manifest,
> `getExpoPushTokenAsync()` fails and no device can ever get a token. The app handles that failure
> gracefully (the customer can still shop; they just get no notifications), but nothing will be
> delivered until this is done.

### Step 2 — Turn it on in the backend

Add one line to `backend/.env`:

```bash
PUSH_PROVIDER=expo
```

Restart the backend. **That is the whole backend change.** You should see:

```
[PushModule] Push notifications: expo
```

### Step 3 (optional) — An Expo access token

Expo accepts push sends without authentication. If you later enable **enhanced security** in the
Expo dashboard, create an access token there and add:

```bash
EXPO_ACCESS_TOKEN=your_token_here
```

### Step 4 — iOS only: Apple credentials

Android works immediately. **iOS needs an Apple Developer account ($99/year)** so Expo can generate
an APNs key on your behalf — `eas credentials` walks you through it.

> This is the same paid Apple account discussed in the SDK-54 note (`CLAUDE.md` §11). **Android
> customers get notifications without it.** If the pilot is Android-first, you can defer this.

### Step 5 — Confirm it works (only you can do this)

1. Run the app on a **real phone** via Expo Go (`npx expo start`, scan the QR).
2. Sign in. The app asks for notification permission — **accept it**.
3. **Close the app completely.**
4. On the merchant dashboard, cancel that customer's order with a reason.
5. The notification should appear on the locked phone: *"Your order was cancelled — The shop
   cancelled your order: <your reason>"*.

If nothing arrives, check the backend log for a `PUSH` line — that tells you whether the backend
tried to send, which splits the problem cleanly in half.

> **Expo Go caveat:** push notifications in **Expo Go** are limited and Expo recommends a development
> build for testing them properly. If Step 5 fails in Expo Go but the backend log shows the send, try
> a development build (`npx expo run:android`) before assuming the code is wrong.

---

## What the customer actually receives

Only things a person would care about. Every internal status change is deliberately **not** pushed —
notifying someone about bookkeeping trains them to ignore the notifications that matter.

| When | What they see |
|---|---|
| Shop confirms | "Order confirmed — The shop has your order and is getting it ready." |
| Shop starts picking | "Your order is being picked" |
| **Item out of stock** | "<item> — open the app to confirm your new total." (needs them to act) |
| **Shop cancels** | "The shop cancelled your order: **<the shop's own reason, verbatim>**" |
| Driver assigned/collected/on way | "Your order is on its way" |
| Delivered | "Delivered — Your order has arrived. Enjoy!" |
| **Shop never responded** | "You can cancel free of charge, or keep waiting." |

---

## Reference

| Variable | Required? | Purpose |
|---|---|---|
| `PUSH_PROVIDER` | for live push | `console` (default, logs only) or `expo` |
| `EXPO_ACCESS_TOKEN` | no | Only if Expo "enhanced security" is enabled |
| `PUSH_TIMEOUT_MS` | no | Send timeout, default `10000` |

---

## Notes on the design

**A tenth table was added: `device_tokens`.** The spec requires a merchant cancellation to "trigger
an immediate notification event to the customer", but none of the eight specified tables has anywhere
to record *which device to notify*. Same precedent as `otp_codes` in Phase 2 — **none of the original
eight tables were altered.**

**A push failure can never break an order.** Every caller is reporting something that has already
happened. An order that was cancelled stays cancelled whether or not the phone was reachable, so
delivery is fire-and-forget and `PushService.notifyUser` never throws. There is a test that breaks
the push service completely and asserts the cancellation still succeeds.

**Dead tokens are deleted, not retried forever.** When Expo reports `DeviceNotRegistered` (the app
was uninstalled, or the token rotated), the row is removed.

**A device is always attached to the signed-in caller**, taken from the verified token — never from a
userId in the request body. Otherwise anyone could register their own phone against a stranger's
account and receive that stranger's order notifications. Unregistering is scoped the same way: a push
token is not a secret, so knowing one must not be enough to silence someone else's phone.

---

## What I verified, and what I could not

**Verified (19 automated tests — `backend/test/push.e2e-spec.ts`):**

- One env var switches the provider to Expo, with no code change.
- The exact request sent to Expo: URL, token, title, body, payload, **high priority and a sound**
  (a silent low-priority notification would defeat the point for a waiting customer).
- **Expo's "HTTP 200 with `status: error`" is treated as a failure.** This is the real trap: checking
  only `response.ok` would count an undelivered notification as delivered.
- A customer with a phone **and** a tablet is notified on both.
- A token that changes hands (a shared family phone) follows the **new** owner, so the previous owner
  stops receiving a stranger's order updates.
- **A completely broken push service does not break the order** — the cancellation still succeeds and
  the event is still recorded.
- The shop's cancellation reason reaches the customer **verbatim**.
- Internal status changes are **not** pushed.
- Endpoint security: the device attaches to the caller (a smuggled `userId` is **rejected**, not
  ignored), a non-Expo token is rejected, an unknown platform is rejected, unauthenticated is 401,
  and **one customer cannot silence another's phone**.

**NOT verified — needs your Expo account and a physical phone:**

- **A notification actually arriving on a real handset.** This needs an Expo `projectId` (Step 1) and
  a real device, neither of which I have. Everything up to Expo's API boundary is tested.
- **The permission prompt** on a real phone, and iOS delivery (which additionally needs the paid
  Apple account).
- That Expo Go is sufficient for testing this, versus needing a development build (see the caveat in
  Step 5).

**B6 is therefore CODE-COMPLETE but NOT PROVEN END-TO-END.** It stays open in the blocker table until
you confirm Step 5 on your phone.
