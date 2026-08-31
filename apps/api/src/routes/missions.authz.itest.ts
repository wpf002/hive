/**
 * Integration tests for the approval gate — the one place a human decision
 * turns into a side effect, so it's the boundary worth locking down.
 *
 * Skips cleanly when no database is reachable (same pattern as
 * auth.authz.itest.ts) so it never blocks `pnpm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@hive/db';

let dbUp = false;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbUp = true;
} catch {
  dbUp = false;
}

const maybe = dbUp ? test : test.skip;

async function fixtures() {
  const user = await prisma.user.create({
    data: {
      email: `swarm-itest-${Date.now()}@example.com`,
      passwordHash: 'x',
      displayName: 'swarm itest',
      role: 'admin',
    },
  });
  const mission = await prisma.mission.create({
    data: {
      userId: user.id,
      name: `itest ${Date.now()}`,
      domain: 'test',
      objective: 'test',
      status: 'running',
      allowedActions: ['notify'],
      limits: {},
    },
  });
  return { user, mission };
}

maybe('an approval is refused once the proposal has expired', async () => {
  const { user, mission } = await fixtures();
  const proposal = await prisma.proposal.create({
    data: {
      missionId: mission.id,
      action: 'notify',
      params: {},
      rationale: 'expired already',
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000),
    },
  });

  // Mirrors the route's conditional update: only flips while still pending
  // AND unexpired. This is the check that makes a late click safe.
  const { count } = await prisma.proposal.updateMany({
    where: { id: proposal.id, status: 'pending', expiresAt: { gt: new Date() } },
    data: { status: 'approved', decidedById: user.id, decidedAt: new Date() },
  });
  assert.equal(count, 0, 'an expired proposal must not be approvable');

  const after = await prisma.proposal.findUnique({ where: { id: proposal.id } });
  assert.equal(after?.status, 'pending');

  await prisma.user.delete({ where: { id: user.id } });
});

maybe('an unexpired proposal approves exactly once', async () => {
  const { user, mission } = await fixtures();
  const proposal = await prisma.proposal.create({
    data: {
      missionId: mission.id,
      action: 'notify',
      params: {},
      rationale: 'live',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    },
  });

  const first = await prisma.proposal.updateMany({
    where: { id: proposal.id, status: 'pending', expiresAt: { gt: new Date() } },
    data: { status: 'approved', decidedById: user.id, decidedAt: new Date() },
  });
  assert.equal(first.count, 1);

  // A second click must not re-approve — the status predicate blocks it.
  const second = await prisma.proposal.updateMany({
    where: { id: proposal.id, status: 'pending', expiresAt: { gt: new Date() } },
    data: { status: 'approved' },
  });
  assert.equal(second.count, 0, 'double-approval must be impossible');

  await prisma.user.delete({ where: { id: user.id } });
});

maybe('the finding dedup key is enforced by the database', async () => {
  const { user, mission } = await fixtures();
  const row = {
    missionId: mission.id,
    agentId: 'a1',
    kind: 'price',
    payload: {},
    sourceId: 'espn',
    sourceKind: 'http',
    observedAt: new Date(),
    fetchedAt: new Date(),
    contentHash: 'a'.repeat(64),
    jobId: 'j1',
  };
  await prisma.finding.create({ data: row });

  await assert.rejects(
    () => prisma.finding.create({ data: { ...row, agentId: 'a2' } }),
    /Unique constraint/,
    'a second agent reporting identical bytes from one source must be rejected',
  );

  await prisma.user.delete({ where: { id: user.id } });
});

maybe('deleting a mission cascades its board rows', async () => {
  const { user, mission } = await fixtures();
  const h = await prisma.hypothesis.create({
    data: {
      missionId: mission.id,
      agentId: 'a1',
      claim: 'c',
      confidence: 0.5,
      supportingFindingIds: ['f1'],
    },
  });
  await prisma.challenge.create({
    data: { hypothesisId: h.id, agentId: 'adv', objection: 'no', severity: 'refutes' },
  });

  await prisma.mission.delete({ where: { id: mission.id } });

  assert.equal(await prisma.hypothesis.count({ where: { id: h.id } }), 0);
  assert.equal(await prisma.challenge.count({ where: { hypothesisId: h.id } }), 0);

  await prisma.user.delete({ where: { id: user.id } });
});

test.after(async () => {
  await prisma.$disconnect();
});
