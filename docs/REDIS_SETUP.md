# Rate limiting that survives a restart (closing blocker B2)

**The problem this fixes:** rate limits were counted **in the app's own memory**. Two consequences,
both bad:

1. **Every restart wiped every limit.** Someone who had been blocked got a fresh budget the moment
   the app was redeployed.
2. **Limits were per-instance.** Run two copies of the API behind a load balancer and an attacker
   gets *double* the budget — one allowance per instance.

Since every login code **costs real money to send** (~$0.04–0.09 per SMS to Jordan), a bypassable
OTP limit is not just a security hole, it is a billing hole.

Counters now live in **Redis**, so they are shared by every instance and survive any restart.

---

## Two limits, not one

| Limit | Keyed on | Default | Stops |
|---|---|---|---|
| OTP requests | **IP address** | 3/min | One machine spamming the endpoint |
| OTP requests | **phone number** | **5/hour** | **One number being targeted from many IPs** |
| OTP verify | IP address | 10/min | Guessing a 6-digit code |
| Registration | IP address | 5/min | Automated shop-signup floods |
| Everything else | IP address | 100/min | General abuse |

**The per-phone limit is new, and it matters.** A per-IP limit alone does not stop a botnet picking
one victim's number and requesting codes from a thousand different IPs — every individual IP stays
inside its budget, while the victim's handset is flooded and **you pay for every message**. The
per-IP limiter cannot see that pattern; it is not looking at the number.

---

## It cannot ship broken by accident

The app **refuses to start in production** without `REDIS_URL`:

```
REDIS_URL is required in production: rate limits would otherwise be in-memory,
resetting on restart and not shared between instances.
```

---

## Local development — already done

Redis is in `docker-compose.yml` and starts with everything else:

```bash
docker compose up -d
```

It runs on host port **6380** (not the usual 6379) to avoid clashing with any Redis already on the
machine, and `backend/.env` already points at it:

```bash
REDIS_URL=redis://localhost:6380
```

Persistence is deliberately **off** for this container: rate-limit counters are short-lived and
rebuildable, so writing them to disk would be pure overhead. Losing them on a container restart costs
at most one extra window of budget.

---

## What you need to do for production

You need a Redis instance the deployed app can reach. Any of these work — all speak the same
protocol, so there is no code change:

| Option | Notes |
|---|---|
| **Your host's built-in Redis** | Render, Railway, Fly.io, Heroku all offer one-click Redis. **Easiest — start here.** |
| **Upstash** (<https://upstash.com>) | Serverless Redis, generous free tier, works from anywhere. Good if your host has none. |
| **Redis Cloud** (<https://redis.com/try-free/>) | The official managed option, 30 MB free. |
| **A Redis container** | Only if you already manage your own servers. |

Whichever you pick, it hands you a connection URL. Set it:

```bash
REDIS_URL=rediss://default:PASSWORD@host:6379
```

Restart. That is the whole change.

> **Use `rediss://` (two s's) for any managed provider** — that is Redis-over-TLS. Plain `redis://`
> sends the password in clear text, which is fine inside a private network and **not** fine across
> the public internet. The app validates the scheme at boot but cannot tell whether your network is
> private, so this one is on you.

**Sizing:** tiny. Counters are a handful of small keys that expire by themselves. The smallest free
tier anywhere is plenty.

---

## What happens if Redis goes down

The per-phone limiter **fails open**: if Redis is unreachable, the request is allowed and an error is
logged.

This is a deliberate judgement call, so overrule it if you disagree. The alternative ("fail closed")
means that when Redis hiccups, **nobody in Jordan can log in at all**. Weighing a total login outage
against the per-phone cap being briefly unenforced — while the per-IP limit and the 5-attempts-per-
code lock both still apply — the outage is clearly the worse outcome. It is logged as an error so it
cannot pass unnoticed.

There is a test pinning this behaviour (*"fails OPEN when Redis is unreachable, rather than locking
everyone out"*), so it is a choice, not an accident.

---

## Reference

| Variable | Required? | Purpose |
|---|---|---|
| `REDIS_URL` | **yes in production** | `redis://` or `rediss://` (TLS). Validated at boot. |
| `RATE_LIMIT_OTP_PER_PHONE_PER_HOUR` | no | Per-number OTP cap, default 5 |
| `RATE_LIMIT_OTP_PER_MIN` | no | Per-IP OTP cap, default 3 |
| `RATE_LIMIT_OTP_VERIFY_PER_MIN` | no | Per-IP verify cap, default 10 |
| `RATE_LIMIT_REGISTER_PER_MIN` | no | Per-IP registration cap, default 5 |
| `RATE_LIMIT_DEFAULT_PER_MIN` | no | Per-IP baseline, default 100 |

> Raise the `RATE_LIMIT_*` values **only** for automated UI test runs (many requests from one IP).
> Never in production.

---

## What I verified

This one is **fully verified locally** — no account needed, because Redis runs in Docker.

**18 automated tests (`backend/test/rate-limit.e2e-spec.ts`) against the REAL Redis**, not a mock.
That was deliberate: the rest of the suite disables the rate-limit guard so it does not throttle
itself, which means nothing else in the project exercises Redis at all. And B2's two claims — limits
survive a restart, limits are shared between instances — are exactly the claims a mock cannot make.

- **Survives a restart:** a brand-new client inherits the existing count (3, not 1).
- **Shared between instances:** two separate clients draw down one budget.
- **A control test proves the old behaviour was genuinely broken:** a fresh in-memory store resets to
  1. Without this, the Redis tests could have been passing for a trivial reason.
- The window does not slide (a caller cannot hold themselves throttled forever), counters do expire,
  and the per-phone limit blocks the right number while leaving a bystander unaffected.

**And verified live, end-to-end, against the running server:**

1. Started the API → log confirms `Rate limiting: redis (redis://localhost:6380)`.
2. Hit the OTP endpoint 4 times → `200, 200, 200, 429`. The counters were **visible in Redis**.
3. **Killed the API process entirely** (a redeploy) → counters still in Redis.
4. Started a **fresh** API process → the very first request returned **429**.

Step 4 is B2 itself. Before this change that request would have returned `200` — a brand-new budget
handed out on every redeploy.

### A trap in my own testing, worth recording

My first attempt at that live check "proved" the opposite — 429s with an empty Redis, implying
in-memory throttling. The cause was **not** the app: a **stale API process from earlier was still
holding port 3000**, so every new process died with `EADDRINUSE` and all my curls hit the old build.
The tests were right; my manual check was measuring the wrong process. Killing the stale process and
re-running gave the result above. Worth remembering: on Windows `pkill` does not exist, so a
background API can outlive what you think you killed — check `netstat -ano | grep :3000`.
