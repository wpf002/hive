# Hive Swarm

Coordination layer on top of Hive's bot orchestration. Turns a pool of
independent bots into a mission with roles, shared state, and one human
approval gate.

Domain-agnostic. The trading desk is one mission config; competitor monitoring,
race-card analysis, repo triage and lead qualification are others. Same machine,
different gatherers and a different executor.

## Where this sits

Hive already handles the hard parts: durable job execution, worker pools,
retries, DLQ, affinity routing, secrets, cost tracking. This layer adds the
thing Hive didn't have — a way for bots to build on each other's output instead
of running in isolation.

```
BotTemplate → Bot → Job → Schedule          (existing Hive)
                     ↓
Mission → MissionAgent(role) → Blackboard → Proposal → approval → Executor
```

| Piece | Where |
|---|---|
| Types, blackboard, dedup, constraints | `packages/swarm` |
| Mission loop + decision step | `apps/coordinator` |
| Mission CRUD, board stream, approval gate | `apps/api/src/routes/missions.ts`, `mission-stream.ts` |
| Terminal | `apps/ui/src/app/(app)/missions/`, `apps/ui/src/components/swarm/` |
| Schema | `packages/db/prisma/schema.prisma` (Swarm section) |

## Roles

| Role | Input | Output | Typical pool |
|---|---|---|---|
| `gatherer` | a schedule | raw payload from exactly one source | `scraper`, `browser`, `monitor` |
| `extractor` | raw payload | `Finding` with provenance | `ai_agent` |
| `analyst` | `Finding[]` | `Hypothesis` with confidence | `ai_agent` |
| `adversary` | `Hypothesis` | `Challenge` | `ai_agent` |
| `constraint` | `Proposal` | pass/fail | code, not a pool |
| `coordinator` | the whole board | one `Decision` | `apps/coordinator` |
| `executor` | approved `Proposal` | a side effect | any |

One gatherer per source. This is a hard rule, and it's enforced rather than
documented: `POST /api/missions/:id/agents` rejects a second gatherer claiming a
`sourceId` that's already taken in that mission.

## The blackboard

Redis stream at `hive:mission:<id>:board`, one consumer group per role
(`role:<name>`). Agents subscribe to the event kinds they care about rather than
being wired into a fixed graph, so adding a role means adding a subscriber, not
editing a DAG.

Entries a role doesn't subscribe to are acked immediately, so a group's pending
list stays small. The stream is trimmed with `MAXLEN ~ 10000` on write.

Both readers — the coordinator loop and the terminal's SSE stream — need the
*whole* board to reason over, because dedup and claim clustering are global
operations. `BoardView` gives them that without re-reading the stream: each
refresh reads only what landed since the last one, and the accumulated window is
capped. Reading the full stream once a second per open terminal is the one place
this design could actually fall over, so it's the path that gets a test
(`board-view.test.ts` asserts the cursor advances and never rewinds).

## Why provenance is mandatory

Three hundred agents reading the same three feeds produce three hundred
findings. A coordinator that counts agents reads that as overwhelming consensus.
It's one signal, observed three hundred times, and acting on it feels
well-supported right up until it isn't.

Every `Finding` carries `sourceId`, `observedAt` and a content hash. The dedup
pass collapses on `(sourceId, contentHash)` before anything is counted, and
hypotheses are ranked by `independentSources` — never by how many agents agree.

Three places enforce this:

1. `collapseFindings()` collapses duplicates before the coordinator counts.
2. The DB rejects them outright: `@@unique([missionId, sourceId, contentHash])`.
3. The coordinator prompt names `agentCount` as a trap, and the
   `requires_independent_support` constraint rule gates on the real number.

The terminal shows both numbers side by side and tags the gap `echo`, so an
operator can see when the swarm is agreeing with itself.

## Constraints are code

Constraint rules are pure functions in `packages/swarm/src/constraints.ts`. No
model calls, no I/O, no clock reads outside the passed context.

A model that can be argued into raising a limit is not a risk control. Keep
budget caps, rate limits and blast-radius checks deterministic, and treat any
impulse to "let the agent decide the limit" as a bug report.

The core rules: `not_expired`, `action_allowed`, `action_rate_limit`,
`mission_action_budget`, `requires_independent_support`, `not_refuted`.

The gates are only as good as the claim they score. `decide()` must copy the
motivating claim back verbatim, and `selectCluster()` resolves it before the
gates run. Scoring the top-ranked cluster instead would quietly turn
`requires_independent_support` into "does *any* claim on this board have enough
sources" and `not_refuted` into "is the *top* claim clean" — letting through
exactly the single-source echo and the refuted claim they exist to stop. A
decision naming a claim that can't be resolved is discarded rather than
defaulted, and `dedup.test.ts` locks all of this in.

## Cost

The naive version of this is unaffordable. 350 agents on a 1-minute cadence is
roughly 500,000 model calls a day.

The design that works:

- Gatherers run on schedules. They're cheap — mostly HTTP, no model.
- Everything downstream is event-triggered off blackboard writes. Idle mission,
  idle agents.
- The coordinator blocks on the board and fires once per genuine change, not on
  a timer. `COORDINATOR_MIN_INTERVAL_MS` puts a floor under that, so a burst of
  twenty board writes collapses into one decision.
- Every coordinator call writes an `AiUsage` row tagged `mission:<id>`, so spend
  is visible per mission in the terminal's status line from day one.

Set `SWARM_MAX_CONCURRENT_AGENTS` and a `mission:actions` limit on every
mission. Run 20 agents for a week and extrapolate before building for 350.

## Approval

Proposals are `pending` until a human acts, and carry a hard `expiresAt`. An
approval arriving after expiry is refused server-side — a stale approval fills
at a price, or acts on a world state, that no longer exists.

The check is a conditional update, not a read-then-write:

```ts
prisma.proposal.updateMany({
  where: { id, status: 'pending', expiresAt: { gt: new Date() } },
  data:  { status: 'approved', decidedById, decidedAt: new Date() },
})
```

A proposal that expires between the read and the write can't slip through, and a
double click can't approve twice. Both cases are covered by
`apps/api/src/routes/missions.authz.itest.ts`.

Approving and rejecting require the `admin` role, matching the admin-only
execution boundary the rest of the API enforces. So does moving a mission to
`running` or widening its `allowedActions`.

`approvalMode: auto_below_threshold` exists for low-stakes actions. Don't reach
for it until a mission has a track record you can read off the digest.

## The terminal

`/missions/<id>` streams a full snapshot once a second over SSE and re-renders
from it. Snapshots rather than deltas: a mission board is small, and an operator
watching an approval countdown must never see a stale view because a frame was
dropped.

The swarm field is a foraging colony, and the layout carries meaning:

- Source patches on the left, one blossom per gatherer's `sourceId`. A patch
  nobody visits is a feed that has gone quiet.
- Gatherers fly to their own patch and carry pollen back, so a bright lane means
  evidence actually moving.
- The comb on the right is the claim board. Cell fill tracks
  `independentSources`, so a comb that fills up is a mission converging and a
  comb of pale cells is a swarm echoing one feed. A refuted cell goes dark red.
- Bees waggle-dance when a claim gains a source — the real signal a colony uses
  to recruit to a find.
- Constraint agents are drawn as fixed hexes at the gate, never as bees. They're
  deterministic code, and anything that looks alive invites the reading that it
  can be reasoned with.
- The coordinator is the queen at the comb's heart, flaring once per decision —
  the only moment a model call happens.

## The agent runtime

Four loops run per running mission, started and stopped as a unit by
`MissionRuntime` and reconciled from the database like everything else:

| Loop | Model call | What it does |
|---|---|---|
| gatherer bridge | never | polls for completed gatherer jobs, turns each upstream item into a `Finding` |
| analyst | yes | collapsed findings → `Hypothesis`, citing the finding ids behind each claim |
| adversary | yes | one claim at a time → `Challenge`, prompted to refute rather than evaluate |
| coordinator | yes | the whole board → one gated `Proposal` |

They are peers, not a pipeline: nothing calls anything else, they communicate
only through the board. That is what lets a role be added or removed without
touching the others.

The gatherer bridge is deterministic on purpose. A gatherer is an ordinary Hive
bot on a schedule — it knows nothing about missions, and its result lands in
`Job.result` like any other. Doing the translation here rather than inside the
workers means every existing pool becomes a usable gatherer with no worker
changes. It polls rather than subscribing, because job completion has no durable
event and a missed message silently drops evidence; a cursor over `finishedAt`
is replayable and survives a restart.

**Hashing is the load-bearing part.** `contentHash` covers one upstream item, not
a whole job — hashing a scoreboard means one score change invalidates every
other game in the same fetch. Volatile fields are stripped per template: the
sportsbook scraper regenerates `fetchedAt` every poll and the ESPN envelope
carries a `date` derived from `now()`, either of which would defeat dedup
entirely while leaving the system looking healthy. Hashing lives in TypeScript
only: Python's `json.dumps` emits `1.0` where `JSON.stringify` emits `1`, so a
cross-language hash of identical data diverges silently.

Verified on live data: an ESPN scrape produced 15 findings; re-running the
identical scrape produced `posted: 0, duplicate: 15`.

## Setup

```bash
pnpm install
pnpm --filter @hive/db migrate:deploy
pnpm --filter @hive/swarm test
pnpm --filter @hive/coordinator dev
```

Try it with demo data:

```bash
pnpm --filter @hive/api seed        # templates + admin (first)
pnpm --filter @hive/api seed:swarm  # one running mission with a live board
```

The demo board is deliberately unflattering: three analysts agree on a claim
only one source supports, next to a quieter claim two independent books back,
next to one an adversary refuted. That's the case the whole dedup pass exists
for, and it should be legible on the comb the moment the terminal opens.

## Defining a mission

Missions are config, not code:

```json
{
  "name": "Race card watch",
  "domain": "racing",
  "objective": "Flag races where the morning line diverges from closing money.",
  "allowedActions": ["notify"],
  "limits": {
    "mission:actions": 40,
    "min_independent_sources": 2,
    "action:notify": 10
  }
}
```

Then bind bots to roles via `POST /api/missions/:id/agents`. Start every new
mission with `allowedActions: ["notify"]` — that's the API default — and let it
run read-only until the digest shows it calling things correctly, then widen.

## Known gaps

- Only the `notify` executor verb is implemented. Any other action is recorded
  as `failed` rather than silently ignored, because a mission whose action never
  happens and never complains is worse than one that errors.
- The coordinator can produce several near-duplicate proposals for the same
  underlying event, because each board change re-runs the decision and the
  claims differ only in wording. Dedup applies to findings, not to proposals.
- `clusterByClaim` normalizes claims with string matching. Fine at 20 agents,
  needs embeddings past a few hundred.
- No replay tooling. Mission state is reconstructable from the stream, but
  there's nothing to do it with.
- `BoardView`'s window is capped at 5,000 entries per kind. A claim whose
  supporting findings age out of the window loses that support. That's
  deliberate — evidence nobody can still see shouldn't keep counting — but it
  means a very slow-burning claim can lose rank over days.
- The coordinator must be a singleton. Two instances would split each mission's
  board and each would decide on half the evidence. The Fly and Railway configs
  pin it to one replica.
