'use client';

import { useEffect, useRef } from 'react';
import type { AgentView, ClaimView } from '@/lib/mission-types';

/**
 * The swarm field: evidence in motion, drawn as filaments rather than sprites.
 *
 * The rendering is trail-accumulation. Every frame the previous frame is faded
 * toward black by a few percent instead of being cleared, then each particle is
 * drawn as a one-pixel segment from its last position to its current one. What
 * you see is therefore a few seconds of motion history at once — the same
 * reason a long-exposure photograph of traffic shows light trails rather than
 * cars. Clearing the buffer each frame would give the same particles as
 * disconnected dots, which reads as noise.
 *
 * What a filament MEANS: one unit of evidence travelling from the source that
 * produced it into the comb. Particles are emitted per source at a rate set by
 * how many findings that source has actually contributed, so a bright lane is a
 * feed doing work and a dark one is a feed that has gone quiet. Density is
 * throughput — it is not decoration, and it is not "one dot per agent", which
 * would make a 10-agent mission look identical to a 350-agent one doing nothing.
 *
 * Motion comes from a curl-like flow field rather than straight seeking, which
 * is what makes the strands braid instead of forming spokes.
 */

const HONEY = [255, 193, 7] as const;
const BURNT = [255, 107, 26] as const;
const ALARM = [196, 69, 58] as const;

/** Filaments in flight per unit of source throughput. Tuned for density, capped below. */
const PARTICLES_PER_SOURCE = 420;
const MAX_PARTICLES = 9000;
/**
 * Fade applied to the previous frame. Lower = longer trails. At 0.028 a strand
 * stays legible for roughly 35 frames, which is what turns moving points into
 * filaments rather than a field of blinking dots.
 */
const TRAIL_FADE = 0.028;

interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  /** 0..1 along its life; recycled at 1. */
  life: number;
  speed: number;
  /** Index of the source patch this filament came from. */
  src: number;
  /** Colour bias: 0 = honey, 1 = burnt (carrying), 2 = alarm (from a stalled source). */
  tint: number;
}

interface Patch {
  sourceId: string;
  x: number;
  y: number;
  weight: number; // relative throughput
  stalled: boolean;
}

export function FlowField({
  agents,
  claims,
  findings,
  findingsPerMin,
  decisionPulse,
}: {
  agents: AgentView[];
  claims: ClaimView[];
  findings: number;
  /** Live arrival rate. The field's energy tracks this, not lifetime totals. */
  findingsPerMin: number;
  decisionPulse: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef({ agents, claims, findings, findingsPerMin });
  dataRef.current = { agents, claims, findings, findingsPerMin };
  const flareRef = useRef(0);

  useEffect(() => {
    if (decisionPulse) flareRef.current = 1;
  }, [decisionPulse]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let particles: Particle[] = [];
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /**
     * Sync the backing store to the element's real size.
     *
     * Called from the draw loop rather than only from a ResizeObserver, because
     * the observer is not reliably the thing that tells us: the canvas is
     * absolutely positioned, and when its box changed without a matching
     * observer callback `w` went stale — the ground fill and every particle
     * spawn are bounded by `w`, so the region beyond the old width was simply
     * never painted and sat there as a hard black bar. Measuring each frame
     * costs a layout read and removes the whole class of bug.
     */
    const resize = () => {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (cw < 8 || ch < 8) return;
      // Sub-pixel settling would otherwise re-seat the field constantly, which
      // pins every particle to its source forever.
      if (w > 0 && Math.abs(cw - w) < 1 && Math.abs(ch - h) < 1) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cw;
      h = ch;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Source positions are derived from w/h, so stale particles would keep
      // streaming out of where the sources used to be.
      particles = [];
      // A resize discards the accumulation buffer, so repaint the ground.
      ctx.fillStyle = '#07070a';
      ctx.fillRect(0, 0, w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    /**
     * Flow field. Layered sines approximate a curl field cheaply — the point is
     * that neighbouring particles get near-identical headings, which is what
     * makes them travel in bundles and read as filaments rather than as a
     * uniform scatter.
     */
    const angleAt = (x: number, y: number, t: number): number => {
      const nx = x / w;
      const ny = y / h;
      return (
        Math.sin(nx * 5.2 + t * 0.00013) * 1.15 +
        Math.sin(ny * 4.1 - t * 0.00017) * 0.95 +
        Math.sin((nx + ny) * 3.3 + t * 0.00009) * 0.7
      );
    };

    const respawn = (p: Particle, patches: Patch[], t: number) => {
      const patch = patches[p.src] ?? patches[0];
      if (!patch) return;
      // Seed across the whole field rather than at a point. Emitting every
      // strand from three coordinates gives three thin lanes and acres of empty
      // black; a colony fills its space. The source a strand belongs to is
      // carried in its colour and in where it enters, not in a single origin.
      const fromSource = Math.random() < 0.34;
      if (fromSource) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 26;
        p.x = patch.x + Math.cos(a) * r;
        p.y = patch.y + Math.sin(a) * r;
      } else {
        p.x = Math.random() * w;
        p.y = Math.random() * h;
      }
      p.px = p.x;
      p.py = p.y;
      p.life = Math.random() * 0.35; // stagger, so the field doesn't pulse in unison
      p.speed = 1.1 + Math.random() * 2.6;
      p.tint = patch.stalled ? 2 : Math.random() < 0.22 ? 1 : 0;
      void t;
    };

    const draw = (t: number) => {
      // Authoritative size check, every frame. Cheap, and it means the field can
      // never be left painting into a stale rectangle.
      resize();
      // Layout may not have sized the canvas yet on the first frame. Spawning
      // into a 0x0 field puts every particle at the origin, where they sit
      // until they expire — so wait for a real size instead.
      if (w < 8 || h < 8) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const {
        agents: liveAgents,
        claims: liveClaims,
        findings: liveFindings,
        findingsPerMin: liveRate,
      } = dataRef.current;

      // --- sources -------------------------------------------------------
      const gatherers = liveAgents.filter((a) => a.role === 'gatherer' && a.sourceId);
      // Weight by RECENT contribution, not lifetime. A feed that delivered a
      // thousand findings yesterday and nothing since should look quiet, which
      // is the whole point of watching the picture rather than a table.
      const bySource = new Map<string, { total: number; stalled: boolean }>();
      for (const g of gatherers) {
        const e = bySource.get(g.sourceId!) ?? { total: 0, stalled: false };
        e.total += g.recentContributions;
        if (g.state === 'stalled') e.stalled = true;
        bySource.set(g.sourceId!, e);
      }
      const srcIds = [...bySource.keys()].sort();
      const patches: Patch[] = srcIds.map((sourceId, i) => ({
        sourceId,
        x: w * 0.06 + (i % 2) * w * 0.03,
        y: ((i + 1) / (srcIds.length + 1)) * h,
        // Floor of 0.15 so a silent feed still renders a thin thread rather
        // than vanishing — absent and idle must not look identical.
        weight: Math.max(0.15, bySource.get(sourceId)!.total),
        stalled: bySource.get(sourceId)!.stalled,
      }));

      // Comb centre — where evidence is heading.
      const combX = w * 0.68;
      const combY = h * 0.5;
      const combR = Math.max(10, Math.min(26, Math.min(h / 15, w / 40)));

      // --- particle population scales with real throughput ---------------
      const totalWeight = patches.reduce((s, p) => s + p.weight, 0) || 1;
      // Energy = live arrival rate, with lifetime findings only as a floor so a
      // mission that has done real work never renders as empty black.
      const energy = 1 + Math.log10(1 + liveRate * 12) * 1.6 + Math.log10(1 + liveFindings) * 0.5;
      const want =
        patches.length === 0
          ? 0
          : Math.min(MAX_PARTICLES, Math.round(PARTICLES_PER_SOURCE * patches.length * energy));
      if (particles.length < want) {
        for (let i = particles.length; i < want; i++) {
          // Distribute across sources proportionally to their contribution.
          let pick = Math.random() * totalWeight;
          let src = 0;
          for (let s = 0; s < patches.length; s++) {
            pick -= patches[s].weight;
            if (pick <= 0) { src = s; break; }
          }
          const p: Particle = { x: 0, y: 0, px: 0, py: 0, life: 1, speed: 1, src, tint: 0 };
          respawn(p, patches, t);
          particles.push(p);
        }
      } else if (particles.length > want) {
        particles.length = want;
      }

      // --- fade instead of clear: this is what makes the trails ----------
      //
      // Painted in DEVICE space over the whole bitmap, not in CSS space over
      // `w`/`h`. Every other bound here is derived from `w`, so if it is ever
      // behind the element's real size the uncovered strip is simply never
      // painted and shows as a hard black bar. Filling the bitmap itself cannot
      // be wrong, whatever `w` currently believes.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = `rgba(7,7,10,${reduceMotion ? 1 : TRAIL_FADE})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // --- filaments ------------------------------------------------------
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1;
      // Additive 1px strokes stack into brightness wherever strands bundle,
      // which is the glow — no blur pass needed, and it stays honest: bright
      // means "many strands here", i.e. more evidence moving.
      for (const p of particles) {
        p.px = p.x;
        p.py = p.y;

        // Turbulence plus drift. The field angle dominates, which is what makes
        // neighbouring strands braid into filaments across the whole frame; a
        // weaker bearing to the comb keeps the net flow inbound so the picture
        // still reads as evidence arriving rather than as an idle screensaver.
        const toComb = Math.atan2(combY - p.y, combX - p.x);
        const dist = Math.hypot(combX - p.x, combY - p.y);
        const flow = angleAt(p.x, p.y, t);
        // Drift only applies on the approach side. Past the comb it would pull
        // strands back toward it, and they would oscillate about it forever
        // instead of carrying on — which is both an artifact and the reason the
        // far side of the field used to stay empty.
        const approaching = p.x < combX;
        const drift = approaching
          ? Math.min(0.5, 0.12 + (1 - Math.min(1, dist / (w * 0.8))) * 0.5)
          : 0;
        const heading = flow * (1 - drift) + toComb * drift;

        const sp = reduceMotion ? 0 : p.speed;
        p.x += Math.cos(heading) * sp;
        p.y += Math.sin(heading) * sp;
        // Lifetime is tuned against travel distance: a strand must survive long
        // enough to cross the field, or the picture is a fringe around each
        // source and empty space in the middle.
        // Long enough to traverse and braid; short enough that the field keeps
        // turning over as new evidence changes the population.
        p.life += 0.0011 + p.speed * 0.0004;

        // Wrap on both axes rather than killing at an edge. A hard edge kill
        // empties whole bands of the field within seconds — vertically in a
        // short viewport, and horizontally everywhere past the comb, which is
        // what left a black column down the right of the screen.
        if (p.y < -10) { p.y += h + 20; p.py = p.y; }
        else if (p.y > h + 10) { p.y -= h + 20; p.py = p.y; }
        if (p.x < -10) { p.x += w + 20; p.px = p.x; }
        else if (p.x > w + 10) { p.x -= w + 20; p.px = p.x; }

        // Capture only at the comb itself — arriving evidence is absorbed.
        if (p.life >= 1 || dist < combR * 1.15) {
          respawn(p, patches, t);
          continue;
        }

        // Fade in and out so strands don't pop.
        const a = Math.sin(p.life * Math.PI) * 0.75;
        const c = p.tint === 2 ? ALARM : p.tint === 1 ? BURNT : HONEY;
        ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${a})`;
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      // --- comb: claims, drawn over the field -----------------------------
      ctx.globalCompositeOperation = 'source-over';
      drawComb(ctx, liveClaims, combX, combY, w, h, flareRef.current);
      flareRef.current = Math.max(0, flareRef.current - 0.01);

      // --- source tags ----------------------------------------------------
      for (const p of patches) drawSourceTag(ctx, p);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      particles = [];
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 block h-full w-full"
      role="img"
      aria-label={`Swarm field: ${findings} findings flowing from ${new Set(agents.map((a) => a.sourceId).filter(Boolean)).size} sources into ${claims.length} claims`}
    />
  );
}

/**
 * Claim cells, laid out in a hex spiral from the centre out. Fill tracks
 * independent source count — a comb of pale cells is a swarm echoing one feed.
 */
function drawComb(
  ctx: CanvasRenderingContext2D,
  claims: ClaimView[],
  cx: number,
  cy: number,
  w: number,
  h: number,
  flare: number,
) {
  const r = Math.max(10, Math.min(26, Math.min(h / 15, w / 40)));

  // Faint backdrop so the comb reads as a structure even when sparse.
  ctx.strokeStyle = 'rgba(255,193,7,0.045)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 37; i++) {
    const { q, r: rr } = spiralHex(i);
    hexPath(ctx, cx + r * 1.75 * (q + rr / 2), cy + r * 1.52 * rr, r);
    ctx.stroke();
  }

  claims.slice(0, 37).forEach((claim, i) => {
    const { q, r: rr } = spiralHex(i);
    const x = cx + r * 1.75 * (q + rr / 2);
    const y = cy + r * 1.52 * rr;
    const fill = Math.min(1, claim.independentSources / 4);

    hexPath(ctx, x, y, r);
    if (claim.refuted) {
      ctx.fillStyle = 'rgba(196,69,58,0.20)';
      ctx.strokeStyle = 'rgba(196,69,58,0.9)';
    } else {
      ctx.fillStyle = `rgba(255,193,7,${0.08 + fill * 0.5})`;
      ctx.strokeStyle = claim.independentSources >= 2 ? 'rgba(255,193,7,0.95)' : 'rgba(120,53,15,0.9)';
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = claim.refuted
      ? 'rgba(196,69,58,1)'
      : claim.independentSources >= 2
        ? '#0A0A0A'
        : 'rgba(161,161,170,0.9)';
    ctx.font = `${Math.max(9, Math.round(r * 0.5))}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(claim.refuted ? '×' : String(claim.independentSources), x, y + r * 0.18);
  });
  ctx.textAlign = 'left';

  // The queen: one flare per coordinator decision — the only moment a model runs.
  ctx.strokeStyle = `rgba(250,250,250,${0.18 + flare * 0.8})`;
  ctx.lineWidth = 1 + flare * 2.5;
  hexPath(ctx, cx, cy, r * (0.55 + flare * 0.45));
  ctx.stroke();
  ctx.lineWidth = 1;
}

/**
 * A source annotation: hex marker at the origin, leader line, plated label.
 *
 * Bare text was unreadable — the strands it sits among are the brightest thing
 * on screen, so a light-grey glyph competes with them and loses. The plate is
 * what makes it legible; the hex ties the name to the point it describes rather
 * than leaving it floating; and the throughput count belongs here because the
 * only question you ask of a source is whether it is still carrying anything.
 */
function drawSourceTag(ctx: CanvasRenderingContext2D, p: Patch): void {
  const accent = p.stalled ? '196,69,58' : '255,193,7';
  const quiet = p.weight <= 1;
  const label = p.sourceId.toUpperCase();
  const count = p.weight > 999 ? '999+' : String(p.weight);

  ctx.font = '600 9px ui-monospace, "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const padX = 6;
  const gap = 6;
  const labelW = ctx.measureText(label).width;
  const countW = ctx.measureText(count).width;
  const plateW = padX + labelW + gap + countW + padX;
  const plateH = 16;
  const markerR = 5;
  const leader = 9;
  const x0 = p.x + markerR + leader;
  const y0 = p.y - plateH / 2;

  // Leader from the marker to the plate.
  ctx.strokeStyle = `rgba(${accent},0.45)`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(p.x + markerR, p.y);
  ctx.lineTo(x0, p.y);
  ctx.stroke();

  // Backing plate — near-opaque so the label survives a bright bundle behind it.
  ctx.fillStyle = 'rgba(7,7,10,0.82)';
  ctx.fillRect(x0, y0, plateW, plateH);
  ctx.strokeStyle = `rgba(${accent},${quiet ? 0.22 : 0.5})`;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, plateW - 1, plateH - 1);

  // Name, then throughput right-aligned inside the plate.
  ctx.fillStyle = p.stalled
    ? `rgba(${accent},0.95)`
    : quiet
      ? 'rgba(161,161,170,0.75)'
      : 'rgba(253,230,138,0.95)';
  ctx.fillText(label, x0 + padX, p.y + 0.5);

  ctx.fillStyle = p.stalled ? `rgba(${accent},0.95)` : `rgba(${accent},${quiet ? 0.45 : 0.9})`;
  ctx.fillText(count, x0 + padX + labelW + gap, p.y + 0.5);

  // Hex marker at the origin, filled so it reads as a node rather than an outline.
  hexPath(ctx, p.x, p.y, markerR);
  ctx.fillStyle = 'rgba(7,7,10,0.9)';
  ctx.fill();
  ctx.strokeStyle = `rgba(${accent},${quiet ? 0.5 : 0.95})`;
  ctx.lineWidth = 1.25;
  ctx.stroke();
  if (!quiet && !p.stalled) {
    // A lit core means this source is actually contributing.
    hexPath(ctx, p.x, p.y, markerR * 0.42);
    ctx.fillStyle = `rgba(${accent},0.9)`;
    ctx.fill();
  }

  ctx.lineWidth = 1;
  ctx.textBaseline = 'alphabetic';
}

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

/** Axial coordinates walking a hex spiral outward from the centre. */
function spiralHex(i: number): { q: number; r: number } {
  if (i === 0) return { q: 0, r: 0 };
  const DIRS: [number, number][] = [
    [1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1],
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
