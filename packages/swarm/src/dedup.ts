import type { Challenge, Finding, Hypothesis } from './types.js';

/**
 * The failure mode this exists to prevent:
 *
 *   300 agents read the same 3 upstream sources. Each produces a Finding.
 *   The coordinator counts 300 agreeing signals and reads it as consensus.
 *   It is one signal, observed 300 times.
 *
 * Collapse on (sourceId, subject, contentHash) first, then count *distinct
 * sources* behind each hypothesis. Agent count is never evidence.
 *
 * Subject is part of both keys because scale comes from covering more entities,
 * not from more bots per entity. Leaving it out of the collapse key would erase
 * every subject after the first whenever two produce identical bytes; leaving it
 * out of the independence count would let a source on one entity corroborate a
 * different source on another.
 */

export function collapseFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.provenance.sourceId}::${f.provenance.subject ?? ''}::${f.provenance.contentHash}`;
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
  const support: Finding[] = [];
  for (const id of hypothesis.supportingFindingIds) {
    const f = byId.get(id);
    if (f) support.push(f);
  }
  return { ...hypothesis, independentSources: independenceOf(support).sources };
}

/**
 * How many distinct sources genuinely agree, and about what.
 *
 * The count is the best *single subject*, not the union across subjects. A claim
 * citing nasdaq/AAPL and yahoo/MSFT touches two sources but nothing is
 * corroborated — each entity was seen once. Taking the union would score that a
 * 2, and a mission fanned out over 200 subjects would manufacture corroboration
 * for free simply by being wide. Taking the per-subject best scores it a 1,
 * which is the truth, and still scores nasdaq/AAPL + yahoo/AAPL as a 2.
 *
 * Findings with no subject share the empty group, so a mission that does not
 * fan out behaves exactly as it did before subjects existed.
 */
export function independenceOf(support: Finding[]): { sources: number; subject: string } {
  const bySubject = new Map<string, Set<string>>();
  for (const f of support) {
    const subject = f.provenance.subject ?? '';
    const set = bySubject.get(subject) ?? new Set<string>();
    set.add(f.provenance.sourceId);
    bySubject.set(subject, set);
  }
  let best = { sources: 0, subject: '' };
  for (const [subject, sources] of bySubject) {
    // Ties broken by name so the reported subject is stable across ticks —
    // a subject that flickers in the UI reads as instability in the data.
    if (sources.size > best.sources || (sources.size === best.sources && subject < best.subject)) {
      best = { sources: sources.size, subject };
    }
  }
  return best;
}

export interface ClaimCluster {
  claim: string;
  members: Hypothesis[];
  /** Distinct upstream sources agreeing about a single subject. The only support measure that counts. */
  independentSources: number;
  /** The subject that support was counted on. Empty when the mission has no fan-out. */
  subject: string;
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
    const support: Finding[] = [];
    for (const m of members) {
      for (const id of m.supportingFindingIds) {
        const f = byFindingId.get(id);
        if (f) support.push(f);
      }
    }
    const independence = independenceOf(support);
    const memberIds = new Set(members.map((m) => m.id));
    const objections = challenges.filter((c) => memberIds.has(c.hypothesisId));
    return {
      claim,
      members,
      independentSources: independence.sources,
      subject: independence.subject,
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
