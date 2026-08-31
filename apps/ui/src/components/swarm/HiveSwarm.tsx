'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { AgentView, ClaimView } from '@/lib/mission-types';

/**
 * The swarm field: every agent is a bee, and the picture is a foraging colony.
 *
 * The layout carries meaning rather than decorating it —
 *
 *   · Source patches sit on the left, one blossom per gatherer's sourceId.
 *     A patch nobody is visiting is a feed that has gone quiet.
 *   · Gatherers fly out to their own patch and carry pollen back. One gatherer
 *     per patch is enforced server-side, so the traffic on a lane is literally
 *     the independent evidence arriving from that source.
 *   · The hive is the comb on the right. Each cell is a claim; cell fill is
 *     independent source count, so a comb that fills up is a mission
 *     converging, and a comb of dim cells is a swarm echoing one feed.
 *   · Extractors and analysts work the comb face. Adversaries patrol and dart
 *     at cells carrying objections — a cell they refute goes dark.
 *   · Constraint agents are the gate: drawn as fixed hexes, never as bees,
 *     because they are deterministic code and shouldn't look alive.
 *   · The coordinator is the queen at the comb's heart. She flares once per
 *     decision, which is the only moment a model call happens.
 *
 * Bees waggle-dance when a claim gains a source — the real signal a colony uses
 * to recruit to a find, and the one moment worth animating loudly.
 */

const HONEY = '#FFC107';
const BURNT = '#FF6B1A';
const ALARM = '#C4453A';
const DIM = '#78350F';
const RULE = '#1F1F1F';
const SUBTLE = '#A1A1AA';

interface Bee {
  id: string;
  role: string;
  state: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 'out' = heading to a patch, 'home' = carrying back to the comb. */
  leg: 'out' | 'home';
  carrying: boolean;
  /** Home cell / station this bee works. */
  homeX: number;
  homeY: number;
  patchX: number;
  patchY: number;
  phase: number;
  /** Countdown while performing a waggle dance. */
  waggle: number;
}

interface Patch {
  sourceId: string;
  x: number;
  y: number;
  visitors: number;
}

interface Cell {
  claim: ClaimView;
  x: number;
  y: number;
}

const ROLE_LANE: Record<string, number> = {
  gatherer: 0.16,
  extractor: 0.42,
  analyst: 0.56,
  adversary: 0.68,
  coordinator: 0.78,
  constraint: 0.9,
  executor: 0.96,
};

export function HiveSwarm({
  agents,
  claims,
  decisionPulse,
}: {
  agents: AgentView[];
  claims: ClaimView[];
  /** Timestamp of the coordinator's last decision — flares the queen. */
  decisionPulse: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const beesRef = useRef<Map<string, Bee>>(new Map());
  const claimSourcesRef = useRef<Map<string, number>>(new Map());
  const flareRef = useRef(0);

  // Latest data, read by the animation loop without restarting it.
  const dataRef = useRef({ agents, claims });
  dataRef.current = { agents, claims };

  const patchIds = useMemo(
    () =>
      Array.from(
        new Set(agents.filter((a) => a.role === 'gatherer' && a.sourceId).map((a) => a.sourceId!)),
      ).sort(),
    [agents],
  );

  // Flare the queen when a new decision lands.
  useEffect(() => {
    if (decisionPulse) flareRef.current = 1;
  }, [decisionPulse]);

  // Recruit dancers when a claim gains independent support.
  useEffect(() => {
    const prev = claimSourcesRef.current;
    let gained = false;
    for (const c of claims) {
      const before = prev.get(c.id);
      if (before !== undefined && c.independentSources > before) gained = true;
      prev.set(c.id, c.independentSources);
    }
    if (gained) {
      for (const bee of beesRef.current.values()) {
        if (bee.role === 'analyst' || bee.role === 'extractor') bee.waggle = 1;
      }
    }
  }, [claims]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const draw = (t: number) => {
      const { agents: liveAgents, claims: liveClaims } = dataRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // --- geometry -------------------------------------------------------
      const patches: Patch[] = patchIds.map((sourceId, i) => ({
        sourceId,
        x: width * 0.08,
        y: ((i + 1) / (patchIds.length + 1)) * height,
        visitors: liveAgents.filter((a) => a.sourceId === sourceId && a.state === 'running').length,
      }));

      const combX = width * 0.6;
      const combY = height / 2;
      // Scale to the shorter axis so the comb fills the field on a laptop and
      // still reads on a wall display, rather than collapsing to dots.
      const cellR = Math.max(11, Math.min(30, Math.min(height / 13, width / 34)));
      const cells: Cell[] = liveClaims.slice(0, 37).map((claim, i) => {
        const axial = spiralHex(i);
        return {
          claim,
          x: combX + cellR * 1.75 * (axial.q + axial.r / 2),
          y: combY + cellR * 1.52 * axial.r,
        };
      });

      drawCombBackdrop(ctx, combX, combY, cellR);
      for (const p of patches) drawPatch(ctx, p, cellR);
      for (const c of cells) drawCell(ctx, c, cellR);
      drawGate(ctx, liveAgents, width, height);
      drawQueen(ctx, combX, combY, cellR, flareRef.current);
      flareRef.current = Math.max(0, flareRef.current - 0.012);

      // --- bees -----------------------------------------------------------
      const bees = beesRef.current;
      const liveIds = new Set<string>();

      for (const agent of liveAgents) {
        if (agent.role === 'constraint') continue; // gate hexes, not bees
        liveIds.add(agent.id);
        let bee = bees.get(agent.id);
        if (!bee) {
          const lane = ROLE_LANE[agent.role] ?? 0.5;
          bee = {
            id: agent.id,
            role: agent.role,
            state: agent.state,
            x: width * lane + rand(-20, 20),
            y: height / 2 + rand(-height * 0.3, height * 0.3),
            vx: 0,
            vy: 0,
            leg: 'out',
            carrying: false,
            homeX: 0,
            homeY: 0,
            patchX: 0,
            patchY: 0,
            phase: Math.random() * Math.PI * 2,
            waggle: 0,
          };
          bees.set(agent.id, bee);
        }
        bee.role = agent.role;
        bee.state = agent.state;

        // Where this bee wants to be.
        if (agent.role === 'gatherer') {
          const patch = patches.find((p) => p.sourceId === agent.sourceId) ?? patches[0];
          bee.patchX = patch?.x ?? width * 0.08;
          bee.patchY = patch?.y ?? height / 2;
          bee.homeX = combX - cellR * 3.4;
          bee.homeY = combY + Math.sin(bee.phase) * cellR * 2;
        } else {
          const lane = ROLE_LANE[agent.role] ?? 0.5;
          const anchor = cells[hashIndex(agent.id, Math.max(1, cells.length))];
          bee.homeX = anchor ? anchor.x : width * lane;
          bee.homeY = anchor ? anchor.y : height / 2;
          bee.patchX = width * lane;
          bee.patchY = height / 2 + Math.sin(bee.phase + t / 2400) * height * 0.28;
        }
      }
      for (const id of [...bees.keys()]) if (!liveIds.has(id)) bees.delete(id);

      for (const bee of bees.values()) {
        stepBee(bee, t, reduceMotion);
        drawBee(ctx, bee, t, reduceMotion);
      }

      // Lane labels last, so bees never obscure the reading.
      drawLegend(ctx, liveAgents, width, height);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [patchIds]);

  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full"
      role="img"
      aria-label={`Swarm field: ${agents.length} agents across ${patchIds.length} sources, ${claims.length} claims on the comb`}
    />
  );
}

// --- behaviour --------------------------------------------------------------

function stepBee(bee: Bee, t: number, reduceMotion: boolean) {
  if (bee.state === 'disabled') return;

  if (bee.waggle > 0) bee.waggle -= 0.006;

  const targetX = bee.leg === 'out' ? bee.patchX : bee.homeX;
  const targetY = bee.leg === 'out' ? bee.patchY : bee.homeY;

  const dx = targetX - bee.x;
  const dy = targetY - bee.y;
  const dist = Math.hypot(dx, dy) || 1;

  if (dist < 14) {
    if (bee.role === 'gatherer') {
      // Load at the patch, unload at the comb.
      bee.carrying = bee.leg === 'out';
      bee.leg = bee.leg === 'out' ? 'home' : 'out';
    } else {
      bee.leg = bee.leg === 'out' ? 'home' : 'out';
    }
  }

  const speed = bee.state === 'stalled' ? 0.06 : bee.state === 'running' ? 1 : 0.42;
  const accel = reduceMotion ? 0 : 0.05 * speed;

  bee.vx += (dx / dist) * accel;
  bee.vy += (dy / dist) * accel;

  // Wander — a colony never flies in straight lines, and a straight line reads
  // as a rendering artefact rather than as activity.
  bee.phase += 0.05;
  const wander = bee.waggle > 0 ? 1.5 : 0.35;
  bee.vx += Math.cos(bee.phase * 1.7) * 0.04 * wander;
  bee.vy += Math.sin(bee.phase * 2.3) * 0.04 * wander;

  // Waggle: a figure eight over the comb, which is what recruitment looks like.
  if (bee.waggle > 0 && !reduceMotion) {
    bee.vx += Math.sin(t / 90) * 0.5;
    bee.vy += Math.sin(t / 45) * 0.28;
  }

  const damp = 0.9;
  bee.vx *= damp;
  bee.vy *= damp;
  const max = 2.6 * speed;
  const v = Math.hypot(bee.vx, bee.vy);
  if (v > max) {
    bee.vx = (bee.vx / v) * max;
    bee.vy = (bee.vy / v) * max;
  }
  bee.x += bee.vx;
  bee.y += bee.vy;
}

// --- drawing ----------------------------------------------------------------

function beeColor(bee: Bee): string {
  if (bee.state === 'stalled') return ALARM;
  if (bee.state === 'disabled') return RULE;
  if (bee.carrying) return BURNT;
  if (bee.state === 'running') return HONEY;
  return DIM;
}

function drawBee(ctx: CanvasRenderingContext2D, bee: Bee, t: number, reduceMotion: boolean) {
  const color = beeColor(bee);
  const angle = Math.atan2(bee.vy, bee.vx);

  // Pollen trail — only for a loaded gatherer, so a bright lane always means
  // evidence actually moving, never just traffic.
  if (bee.carrying) {
    ctx.strokeStyle = 'rgba(255,107,26,0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bee.x - bee.vx * 6, bee.y - bee.vy * 6);
    ctx.lineTo(bee.x, bee.y);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(bee.x, bee.y);
  ctx.rotate(angle);

  // Wings, only while actually flying.
  if (!reduceMotion && bee.state === 'running') {
    const flap = Math.abs(Math.sin(t / 28 + bee.phase));
    ctx.fillStyle = `rgba(250,250,250,${0.12 + flap * 0.18})`;
    ctx.beginPath();
    ctx.ellipse(-0.8, -3, 3.4, 1.3 + flap, -0.5, 0, Math.PI * 2);
    ctx.ellipse(-0.8, 3, 3.4, 1.3 + flap, 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Body.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, 4, 2.6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Two stripes. A handful of pixels, but it's what makes the field read as
  // bees rather than as particles.
  ctx.fillStyle = 'rgba(10,10,10,0.8)';
  ctx.fillRect(-1.4, -2.6, 1.1, 5.2);
  ctx.fillRect(0.8, -2.2, 1.1, 4.4);

  if (bee.waggle > 0) {
    ctx.strokeStyle = `rgba(255,193,7,${bee.waggle * 0.5})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPatch(ctx: CanvasRenderingContext2D, patch: Patch, r: number) {
  const active = patch.visitors > 0;
  ctx.strokeStyle = active ? HONEY : RULE;
  ctx.fillStyle = active ? 'rgba(255,193,7,0.10)' : 'transparent';
  hexPath(ctx, patch.x, patch.y, r * 0.95);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = active ? SUBTLE : '#4A4A4A';
  ctx.font = '10px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(truncate(patch.sourceId, 14), patch.x, patch.y + r * 1.9);
  ctx.textAlign = 'left';
}

function drawCell(ctx: CanvasRenderingContext2D, cell: Cell, r: number) {
  const { independentSources, refuted } = cell.claim;
  // Fill tracks independent support, not agent count. A comb of pale cells is
  // the picture of a swarm agreeing with itself.
  const fill = Math.min(1, independentSources / 4);

  hexPath(ctx, cell.x, cell.y, r);
  if (refuted) {
    ctx.fillStyle = 'rgba(196,69,58,0.16)';
    ctx.strokeStyle = ALARM;
  } else {
    ctx.fillStyle = `rgba(255,193,7,${0.06 + fill * 0.42})`;
    ctx.strokeStyle = independentSources >= 2 ? HONEY : RULE;
  }
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = refuted ? ALARM : independentSources >= 2 ? '#0A0A0A' : SUBTLE;
  ctx.font = `${Math.max(8, Math.round(r * 0.55))}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(refuted ? '×' : String(independentSources), cell.x, cell.y + r * 0.2);
  ctx.textAlign = 'left';
}

function drawCombBackdrop(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number) {
  ctx.strokeStyle = 'rgba(255,193,7,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 61; i++) {
    const { q, r } = spiralHex(i);
    hexPath(ctx, cx + radius * 1.75 * (q + r / 2), cy + radius * 1.52 * r, radius);
    ctx.stroke();
  }
}

function drawQueen(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, flare: number) {
  ctx.strokeStyle = `rgba(255,193,7,${0.35 + flare * 0.65})`;
  ctx.lineWidth = 1.5 + flare * 2;
  hexPath(ctx, x, y, r * (0.62 + flare * 0.5));
  ctx.stroke();
}

/**
 * Constraint agents. Fixed hexes at the hive gate, never bees — they're pure
 * functions, and anything that looks alive on this canvas invites the reading
 * that it can be reasoned with.
 */
function drawGate(
  ctx: CanvasRenderingContext2D,
  agents: AgentView[],
  width: number,
  height: number,
) {
  const gate = agents.filter((a) => a.role === 'constraint');
  if (gate.length === 0) return;
  const x = width * 0.9;
  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, height * 0.2);
  ctx.lineTo(x, height * 0.8);
  ctx.stroke();

  gate.forEach((a, i) => {
    const y = height * 0.3 + i * 22;
    ctx.strokeStyle = a.state === 'disabled' ? RULE : '#FAFAFA';
    ctx.fillStyle = 'rgba(250,250,250,0.06)';
    hexPath(ctx, x, y, 7);
    ctx.fill();
    ctx.stroke();
  });
}

function drawLegend(
  ctx: CanvasRenderingContext2D,
  agents: AgentView[],
  width: number,
  height: number,
) {
  ctx.font = '9px ui-monospace, monospace';
  const roles = Object.keys(ROLE_LANE);
  roles.forEach((role) => {
    const n = agents.filter((a) => a.role === role).length;
    if (n === 0) return;
    const x = width * ROLE_LANE[role];
    ctx.fillStyle = '#4A4A4A';
    ctx.fillText(`${role} ${n}`, Math.min(x, width - 70), height - 6);
  });
}

// --- helpers ----------------------------------------------------------------

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/**
 * Axial coordinates walking a hex spiral outward from the centre, so claim
 * cells fill the comb from the middle out and the strongest claim (index 0,
 * ranked by independent sources) always sits at the heart of the hive.
 */
function spiralHex(i: number): { q: number; r: number } {
  if (i === 0) return { q: 0, r: 0 };
  const DIRS: [number, number][] = [
    [1, -1],
    [1, 0],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [0, -1],
  ];
  let ring = 1;
  let ringStart = 1;
  while (ringStart + 6 * ring <= i) {
    ringStart += 6 * ring;
    ring += 1;
  }
  const idx = i - ringStart;
  const side = Math.floor(idx / ring);
  const step = idx % ring;

  // Start `ring` cells out along direction 4, then walk whole edges, then the
  // remainder along the current edge.
  let q = DIRS[4][0] * ring;
  let r = DIRS[4][1] * ring;
  for (let s = 0; s < side; s++) {
    q += DIRS[s][0] * ring;
    r += DIRS[s][1] * ring;
  }
  q += DIRS[side][0] * step;
  r += DIRS[side][1] * step;
  return { q, r };
}

function hashIndex(id: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % mod;
}

function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
