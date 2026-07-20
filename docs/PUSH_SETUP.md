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

---

## Notification SOUND — the fix, and how to verify it on your phone (2026-07-20)

**The problem you reported:** the new-order push arrives on the merchant phone (even when closed), but
it is **silent** — no sound. For a shopkeeper who is not staring at the phone, a silent notification is
as good as no notification.

**Why it was silent (the diagnosis).** On Android 8+ the **sound, importance and heads-up behaviour of
a notification are properties of the notification CHANNEL, not the push message.** Two things were
wrong:

1. The push message the server sent **did not name a channel** (`channelId`). Without one, Android
   delivers the notification through Expo's *silent fallback channel*, and the `sound` in the message
   is ignored.
2. The channel the app created (`"orders"`) was made with a high importance but **no explicit sound**.

**What I changed (all code, already done and tested):**

- The server now sends every order push with `channelId: "orders-v2"` and `sound: "default"`
  (`backend/src/orders/notifications.service.ts`, `backend/src/push/expo-push.sender.ts`).
- Both apps now create a channel **`"orders-v2"`** with `sound: "default"` and **MAX** importance on
  the merchant app (heads-up + sound even when locked), **HIGH** on the customer app
  (`merchant-app/src/push.ts`, `mobile/src/push.ts`).
- **Why a new channel id (`orders-v2`) and not `orders`?** **Android notification channels are
  immutable once created.** A phone that already installed an earlier build made the old soundless
  `"orders"` channel — and re-declaring it with a sound is a silent no-op. A **fresh id** is guaranteed
  to be created with sound enabled. (iOS has no channels; there the payload `sound: "default"` drives
  it, and that was already present — iOS was likely already making a sound.)

**⚠️ IMPORTANT for your test:** because the old `orders` channel may still exist on your phone from a
previous run, **fully reinstall the merchant app (or clear its app data / storage in Android Settings)
before testing**, so the new `orders-v2` channel is created cleanly. Otherwise Android may still route
to (or remember) the old soundless channel.

### 👉 How to verify the sound yourself (needs your phone + Expo project from Step 5)

1. Make sure `PUSH_PROVIDER=expo` is set and Step 5 is done (real `projectId`, app runs on your phone).
2. **Reinstall the merchant app** on the phone (or clear its data) — see the warning above.
3. Open the merchant app once and **sign in** — this is what creates the `orders-v2` sound channel and
   registers the device. Grant the notification permission when asked.
4. Check the phone's **media/notification volume is up** and the phone is **not** in silent/Do-Not-
   Disturb mode. (A silent phone is a phone setting, not an app bug.)
5. **Lock the phone** and fully close (swipe away) the merchant app.
6. From the customer app (or the customer web target), **place an order** against your shop.
7. **Expected:** within a few seconds the phone **plays the default notification sound, vibrates, and
   shows a heads-up banner on the lock screen** reading "New order".
8. Optional cross-check: in Android **Settings → Apps → (merchant app) → Notifications** you should see
   a channel **"New orders"** with sound switched **on** and importance "Urgent" — confirming the new
   channel took effect.

If it is still silent after a clean reinstall: check the per-app channel setting in step 8 (the user
can override a channel's sound in system settings — the app cannot force it back once the user changes
it), and confirm DND is off.

> **What is proven without hardware:** every automated test asserts the server now sends `channelId:
> "orders-v2"` and `sound: "default"` on both the merchant new-order push and the customer order pushes
> (`backend/test/push.e2e-spec.ts`, 23 tests). The actual sound coming out of the speaker is
> device-only — it needs the phone walk-through above. Same class of "web/CI-verified, device-pending"
> caveat as the rest of push (B6b).
