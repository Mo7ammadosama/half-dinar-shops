# Sending real login codes by SMS (closing blocker B3)

**Read this first:** there is a **~12 working-day approval wait** in this process that nothing can
shorten. If you do only one thing today, do **Step 2** — start the Sender ID registration, then come
back and finish the rest while it is being approved.

The app is **fully built and wired for real SMS**. No code needs to change. You are pasting three
values into a config file.

---

## What is happening right now (and why login "works" in testing)

Today the app uses the **console sender**: it prints the login code to the server log and shows it on
screen instead of texting it. That is why you can sign in during testing without a phone signal.

That is development-only, and it is **guarded**, not merely discouraged:

- The app **refuses to start** in production without a real SMS provider configured.
- The app **refuses to start** in production if the code-on-screen setting is on.

So this cannot silently ship. It will fail loudly on the launch deploy instead — which is the point.

---

## The Jordan-specific rules that shaped this (important)

I researched Jordan's SMS rules rather than assuming they match the rest of the world. They do not,
and these constraints are the reason for the steps below:

| Rule in Jordan | What it means for us |
|---|---|
| **Alphanumeric Sender ID requires pre-registration** — *international and domestic both mandatory*, **~12 days** | You must apply well before launch. This is the long pole. |
| **Zain and Orange block generic sender IDs** | Skipping registration ≠ "messages look generic". It means **messages do not arrive at all** on two of Jordan's major networks. |
| **Long codes and short codes are not supported domestically** | You cannot buy a normal Jordanian number and text from it. A registered Sender ID is the only route. |
| **Two-way SMS is not supported** | Customers cannot reply to the code. Our flow never asks them to — nothing to change, but don't design on it later. |
| **Promotional messages need an `adv` prefix and are banned after 9pm Amman time** | Our login SMS is strictly transactional (no marketing words), so the 9pm curfew does **not** apply to it. **Do not add marketing text to the login message** — it would reclassify it and could get codes blocked at night. There is a test pinning this. |

---

## Which provider I chose, and why

**Twilio.** Reasoning, so you can overrule it:

- **Self-serve signup with a card.** You can complete it yourself today. Unifonic and most regional
  aggregators are sales-led — a quote, a contract, a call. That could take longer than the build did.
- It handles the Jordanian Sender ID registration paperwork with the carriers on your behalf.
- Well-documented, stable API.

**When Twilio is the wrong choice:** at real volume, a regional aggregator (Unifonic, or a local
Jordanian reseller) is usually **noticeably cheaper per message** and often has better local delivery
routes. That is a "month three" optimisation, not a launch decision.

**Switching providers later is a small, contained job** — one new class in `backend/src/sms/`, no
changes to any caller. That was the entire point of building it behind an interface. See
"Adding a different provider" below.

---

## What you need to do

### Step 1 — Create a Twilio account

1. Go to <https://www.twilio.com/try-twilio> and sign up.
2. Verify your email and your own phone number.
3. **Upgrade to a paid account.** Trial accounts can only send to numbers you have personally
   verified — useless for real customers. You do not need to pre-load much; billing is per message.

### Step 2 — Register your Alphanumeric Sender ID ⏰ **DO THIS FIRST — ~12 days**

This is the long wait. Start it before anything else.

1. In the Twilio Console, go to **Messaging → Sender IDs → Alphanumeric Sender ID**.
2. Register a sender ID for **Jordan**. Suggested: `HalfDinar` (max 11 characters, letters/digits).
3. Twilio will ask for business details and may ask for documents. Fill them in and submit.
4. Wait for approval — **budget ~12 working days.**

> **Do not skip this.** Without an approved Sender ID, Zain and Orange **will not deliver your login
> codes at all**, and customers simply cannot sign in. It will look like the app is broken.

### Step 3 — Collect three values

From the Twilio Console home page:

| Value | Where it is | Looks like |
|---|---|---|
| **Account SID** | Console dashboard | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| **Auth Token** | Console dashboard (click to reveal) | a long secret string |
| **Sender ID** | what you registered in Step 2 | `HalfDinar` |

### Step 4 — Paste them in

Open `backend/.env` and add these four lines:

```bash
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_SMS_FROM=HalfDinar

# Turn OFF the development shortcut that shows the code on screen.
EXPOSE_OTP_IN_RESPONSE=false
```

Then restart the backend. **That is the whole change.** No code edits.

The app auto-detects the credentials and switches to real SMS. On startup you will see:

```
[SmsModule] SMS provider: twilio (sender HalfDinar)
```

If you instead see the console warning, one of the three values is missing or misspelled.

> **Never commit `.env`.** It is git-ignored. On a real server, set these as environment variables in
> the hosting platform rather than in a file.

### Step 5 — Confirm it works

Request a login code on a real phone. You should receive a text from `HalfDinar` reading:

> `123456 is your Half-Dinar Shops login code. It expires in 5 minutes. Do not share it with anyone.`

If nothing arrives, check **Monitor → Logs → Messaging** in the Twilio Console. The error code there
tells you exactly what went wrong (a `21612`-type error usually means the Sender ID is not approved
for Jordan yet — i.e. Step 2 has not completed).

---

## Cost

Roughly **$0.04–0.09 per SMS to Jordan**, billed per message. One login = one SMS.

The abuse protection matters here because **every OTP request costs you money**:

- 3 code requests per minute per IP address
- 5 code requests per hour per **phone number** (added in Phase 8 — see B2)

Without the per-phone limit, someone could pick one number and bill you repeatedly from many IPs.

---

## Adding a different provider (e.g. Unifonic)

The swap is contained by design:

1. Add `backend/src/sms/unifonic-sms.sender.ts` implementing the `SmsSender` interface
   (`name`, `deliversRealMessages`, `send()`) — copy `twilio-sms.sender.ts` as the model.
2. Add one branch in `createSmsSender()` in `backend/src/sms/sms.module.ts`.
3. Add the provider name to the allowed list in `backend/src/config/env.validation.ts`.

**No caller changes.** `AuthService` only knows the interface. The existing tests cover the seam, so
a new provider inherits the OTP-flow test for free.

---

## Reference — every SMS setting

| Variable | Required? | Purpose |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | for live SMS | Twilio account identifier |
| `TWILIO_AUTH_TOKEN` | for live SMS | Twilio secret |
| `TWILIO_SMS_FROM` | one of these two | Registered Alphanumeric Sender ID (e.g. `HalfDinar`) |
| `TWILIO_MESSAGING_SERVICE_SID` | one of these two | Use a Twilio Messaging Service instead of a bare sender ID |
| `SMS_PROVIDER` | no | Force `console` or `twilio`. Auto-detected when unset. |
| `SMS_TIMEOUT_MS` | no | Send timeout, default `10000` |
| `EXPOSE_OTP_IN_RESPONSE` | no | Dev only — returns the code in the API response. Must be `false`/unset in production (enforced at boot). |

---

## What I verified, and what I could not

**Verified (real, automated tests — `backend/test/sms.e2e-spec.ts`, 17 tests):**

- The login code **inside the SMS body** is the code that actually logs you in. The test pulls the
  6-digit code out of the message text and signs in with it — proving the message a customer receives
  is genuinely useful, not that a mock got called.
- Providing credentials switches the provider to Twilio with **no code change**; removing them falls
  back to console.
- The exact HTTP request sent to Twilio is correct: URL, `To`, `From`, body, and Basic auth header.
- A Twilio rejection or a network timeout surfaces as an error the customer sees ("we could not send
  your code"), instead of leaving them waiting for a code that will never arrive.
- **Production refuses to boot** without a real provider, and still refuses with the code exposed.
- The message body stays strictly transactional (the Jordan promotional-classification rule).

**NOT verified — needs your account:**

- **A real SMS actually arriving on a real Jordanian phone.** This needs a paid Twilio account and an
  approved Sender ID, neither of which I can create. Everything up to Twilio's API boundary is
  tested; delivery from Twilio to a Zain/Orange handset is the part only you can confirm — do it as
  Step 5 above.
- **Real-world delivery latency and cost per message in Jordan.**
