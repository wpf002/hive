import type { Challenge, Finding, Hypothesis } from './types.js';

/**
 * The failure mode this exists to prevent:
 *
 *   300 agents read the same 3 upstream sources. Each produces a Finding.
 *   The coordinator counts 300 agreeing signals and reads it as consensus.
 *   It is one signal, observed 300 times.
 *
 * Collapse on (sourceId, contentHash) first, then count *distinct sources*
 * behind each hypothesis. Agent count is never evidence.
 */

export function collapseFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.provenance.sourceId}::${f.provenance.contentHash}`;
    const prior = seen.get(key);
    // Keep the earliest observation of identical content.
    if (!prior || f.provenance.observedAt < prior.provenance.observedAt) {
      seen.set(key, f);
    }
  }
  return [...seen.values()];
}

export function scoreIndependence(hypothesis: Hypothesis, findings: Finding[]): Hypothesis {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const sources = new Set<string>();
  for (const id of hypothesis.supportingFindingIds) {
    const f = byId.get(id);
    if (f) sources.add(f.provenance.sourceId);
  }
  return { ...hypothesis, independentSources: sources.size };
}

export interface ClaimCluster {
  claim: string;
  members: Hypothesis[];
  /** Distinct upstream sources behind the cluster. The only support measure that counts. */
  independentSources: number;
  /** Mean confidence across members. Informational — never a substitute for the above. */
  meanConfidence: number;
  /** Objections raised against any member. */
  objections: Challenge[];
  /** True if any objection refutes. Disqualifies the cluster outright. */
  refuted: boolean;
}

/**
 * Agreement between hypotheses only counts when the underlying sources differ.
 * Returns clusters of hypotheses making the same claim, annotated with how much
 * genuinely independent support each cluster has, ranked strongest first.
 */
export function clusterByClaim(
  hypotheses: Hypothesis[],
  findings: Finding[],
  challenges: Challenge[] = [],
): ClaimCluster[] {
  const byFindingId = new Map(findings.map((f) => [f.id, f]));
  const clusters = new Map<string, Hypothesis[]>();

  for (const h of hypotheses) {
    const key = normalizeClaim(h.claim);
    clusters.set(key, [...(clusters.get(key) ?? []), h]);
  }

  const out: ClaimCluster[] = [...clusters.entries()].map(([claim, members]) => {
    const sources = new Set<string>();
    for (const m of members) {
      for (const id of m.supportingFindingIds) {
        const f = byFindingId.get(id);
        if (f) sources.add(f.provenance.sourceId);
      }
    }
    const memberIds = new Set(members.map((m) => m.id));
    const objections = challenges.filter((c) => memberIds.has(c.hypothesisId));
    return {
      claim,
      members,
      independentSources: sources.size,
      meanConfidence: members.reduce((s, m) => s + m.confidence, 0) / members.length,
      objections,
      refuted: objections.some((o) => o.severity === 'refutes'),
    };
  });

  // Strongest first: independent support, then confidence. Never member count.
  return out.sort(
    (a, b) => b.independentSources - a.independentSources || b.meanConfidence - a.meanConfidence,
  );
}

export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Finds the cluster a decision was actually about.
 *
 * This exists because the constraint gates are only as good as the claim they
 * score. Handing them `clusters[0]` — the best-supported claim on the board —
 * silently turns `requires_independent_support` from "does THIS claim have
 * enough distinct sources" into "does ANY claim on this board", and turns
 * `not_refuted` into "is the top-ranked claim un-refuted". A single-source echo
 * or an explicitly refuted claim would then sail through the exact gate built
 * to stop it.
 *
 * Returns null when the claim can't be identified. Callers must refuse to
 * propose in that case: falling back to a default cluster reintroduces the bug.
 */
export function selectCluster(clusters: ClaimCluster[], claim: string | null): ClaimCluster | null {
  if (!claim) return null;
  const target = normalizeClaim(claim);
  if (!target) return null;
  return clusters.find((c) => normalizeClaim(c.claim) === target) ?? null;
}
