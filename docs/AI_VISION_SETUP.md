# AI product entry — photograph an item, skip the typing

**The problem this solves:** a half-dinar shop stocks *thousands* of items. Adding each one by hand
means typing a name, choosing a category, and entering a price — three fields, on a laptop, thousands
of times. That is the single most likely reason a real shopkeeper abandons their catalogue half-built.
And an app with a half-built catalogue is an app nobody shops in.

Now: the merchant **photographs the item** (which they were going to do anyway — products need
photos), and the name, category and price **fill themselves in** for the merchant to check.

It is **fully built and working right now** in demo mode. Pasting one API key makes it real.

---

## Measured — is it actually faster?

Measured in a real browser, driving the real dashboard
(`merchant-dashboard/e2e/ai-product-entry.spec.ts`):

| | Manual entry | AI-assisted |
|---|---|---|
| **Time per item** | **4,482 ms** | **282 ms** |
| Characters typed | 21 | **0** |
| Fields filled | 3 | **0** |
| Dropdowns opened | 1 | **0** |

**~94% less time per item, on the workflow.**

### ⚠️ Read this before believing that number

- **It measures the workflow, not the AI.** The demo analyzer answers instantly. **A live Claude call
  adds roughly 1–3 seconds per item, which is NOT in the 282ms.** Realistically expect ~2–4 seconds
  per item live, versus ~4.5 seconds manual — still faster, but *not* 94% faster.
- **The real win is the typing, not the clock.** 0 characters instead of 21. Over 2,000 items that is
  ~42,000 characters not typed. The fatigue difference is the point; the seconds are secondary.
- **The typing speed is an assumption** (140ms/character, ~7 chars/sec) — chosen to be **generous to
  the manual path**. A real shopkeeper typing unfamiliar product names is likely slower, which would
  make the gap wider. Erring fast keeps the comparison honest.
- **A longer product name widens the gap.** "Chocolate Bar 30g" is 17 characters; plenty of real
  items are longer.

---

## What you need to do (~5 minutes)

### Step 1 — Get an Anthropic API key

1. Sign up at <https://console.anthropic.com>.
2. Add a payment method (this is pay-as-you-go — no subscription).
3. **API Keys → Create Key.** Copy it — it is shown once.

### Step 2 — Paste it in

Add one line to `backend/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

Restart the backend. **That is the whole change.** You should see:

```
[VisionModule] AI product entry: claude (claude-opus-4-8)
```

If you instead see the "mock — suggestions are canned" warning, the key is missing or misspelled.

### Step 3 — Try it

Open the dashboard → Products → **Add a product** → choose a photo of a real item. The name, price
and category should fill in by themselves, with a confidence score, for you to check.

---

## Cost

Roughly **$0.01–0.03 per photo** with the default model, and **you only pay when a merchant adds a
product** — not per customer, not per order.

For a 2,000-item catalogue that is a **one-off cost of roughly $20–60** to build the entire
catalogue. Against the alternative — a person typing 2,000 items by hand — that is not a close call.

**To cut the cost:** set a cheaper model. This is a config change, not a code change:

```bash
VISION_MODEL=claude-sonnet-5      # noticeably cheaper; still very capable at this
```

Product recognition is not a hard reasoning task, so **Sonnet is worth trying first** if cost matters
— I defaulted to Opus for accuracy, but this is exactly the knob to turn.

---

## How the merchant experiences it

1. They pick a photo. It uploads (as before) **and** is read.
2. The three fields fill in. A banner says **"Filled in from the photo — please check"** with a
   confidence percentage.
3. If the AI is unsure (<50%), the banner changes to **"Not sure what this is — please fill it in"**
   and is styled differently — so a weak guess *looks* weak instead of being waved through.
4. They correct anything wrong and press **Add product**.

**Nothing is ever saved by the AI.** The suggestion only fills a form; the merchant still presses the
button. That separation is deliberate and enforced server-side — an AI that could write straight to
the catalogue would put its mistakes in front of customers at a real price.

---

## Reference

| Variable | Required? | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | for real AI | Your Anthropic key. Absent = demo mode. |
| `VISION_MODEL` | no | Default `claude-opus-4-8`. Try `claude-sonnet-5` to cut cost. |
| `VISION_PROVIDER` | no | Force `mock` or `claude`. Auto-detected from the key. |
| `VISION_TIMEOUT_MS` | no | Default `30000` |

---

## Design notes

**The AI proposes; the merchant decides.** Suggestion and creation are separate endpoints. There is a
test (*"SAVES NOTHING — the suggestion is not a product"*) that fails if that ever changes.

**It cannot invent a category.** The model is given the shop's real category list and may only return
an id from it. Anything else is rejected server-side and the field is left blank — a free-text
category would need reconciling against the master list later, which is exactly the manual work this
removes.

**It cannot produce a broken price.** Only an exact 2-decimal value is accepted; "about 0.5" is
dropped. Structured outputs guarantee the *shape* of the answer, not its *truth* — so both of these
are checked again on our side.

**It never overwrites what the merchant typed.** Only empty fields are filled.

**A failure degrades to typing, never to a dead end.** If the AI is down, the photo still uploads and
the merchant fills the form in exactly as they did before.

**It reuses the same magic-byte validation as the upload endpoint** — the AI route must not become
the weak way to smuggle a non-image into the system. There is a test for that too.

---

## What I verified, and what I could not

**Verified (20 backend tests + 6 real-browser tests):**

- The exact request sent to Claude: the real image bytes, the shop's real category ids, the
  half-dinar pricing context, and structured outputs.
- **An invented category id is rejected** and the field left blank — while keeping the rest of the
  suggestion, since one bad field is no reason to throw away a good name.
- **A malformed price ("about 0.5") is rejected.** A nonsense confidence is clamped.
- **A safety refusal is handled as a failure, not a crash** — a refusal returns an empty content
  array, so reading `content[0]` would have thrown a `TypeError`.
- **The suggestion saves nothing** — the product count is unchanged after a suggestion.
- The AI route rejects a script disguised as a `.png`, refuses a customer (403), refuses anonymous
  (401).
- **In a real browser:** the fields genuinely fill from a photo with nothing typed; the confidence is
  shown; demo mode says it is demo mode; typed values are never overwritten; and a corrected
  suggestion saves the *merchant's* value.
- **The time-per-item measurement above**, taken in a real browser rather than estimated.

**NOT verified — needs your API key:**

- **Whether Claude actually identifies real products correctly**, and how accurate it is on genuine
  half-dinar shop items in a real shop's lighting. This is the whole question, and it cannot be
  answered without a key and real photos. Everything up to the API boundary is tested; the accuracy
  itself is Step 3 above.
- **Real per-photo cost and latency.** My $0.01–0.03 and 1–3s figures are estimates, not measurements.
