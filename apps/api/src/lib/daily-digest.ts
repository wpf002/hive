import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@hive/db';
import { env } from '../env.js';

/**
 * Daily bot-effectiveness digest. Pure-ish data assembly + optional AI
 * "lessons learned" + HTML/text rendering. The route layer decides whether to
 * email it; this module never sends, so it's easy to unit-test and to preview.
 */

export interface BotStat {
  botId: string;
  botName: string;
  pool: string;
  templateName: string;
  enabled: boolean;
  runs: number;
  succeeded: number;
  failed: number;
  other: number; // queued/running/cancelled at snapshot time
  latestStatus: string | null; // status of the most recent run in the window
  lastResultSummary: string | null;
  errorSamples: string[];
}

export interface Digest {
  windowStart: string;
  windowEnd: string;
  totals: { bots: number; ran: number; idle: number; runs: number; succeeded: number; failed: number };
  bots: BotStat[];
  failing: BotStat[];
  lessonsLearned: string | null;
}

// Snapshot of a single failing bot stored in DigestRun for next-day comparison.
export interface BotFailSnapshot {
  botId: string;
  botName: string;
  pool: string;
  errorSamples: string[];
  lessonText: string | null; // Claude's per-bot recommendation from that day
}

export interface DigestRunRecord {
  id: string;
  windowEnd: Date;
  failingBots: BotFailSnapshot[];
  lessonsLearned: string | null;
  createdAt: Date;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ERR_SAMPLES = 3;

function summarizeResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result !== 'object') return String(result).slice(0, 160);
  const r = result as Record<string, unknown>;
  const picks: string[] = [];
  for (const k of ['ok', 'gameCount', 'statusCode', 'latencyMs', 'mode', 'exchange', 'symbol', 'fillPrice', 'exitCode', 'observations', 'maxSpreadPct', 'port', 'pageTitle']) {
    if (k in r && r[k] !== null && r[k] !== undefined) picks.push(`${k}=${JSON.stringify(r[k])}`);
  }
  if (picks.length > 0) return picks.join(', ').slice(0, 200);
  return JSON.stringify(r).slice(0, 200);
}

/** Assemble the 24h digest across every bot (including ones that didn't run). */
export async function buildDigest(now: Date = new Date()): Promise<Digest> {
  const since = new Date(now.getTime() - WINDOW_MS);

  const [bots, jobs] = await Promise.all([
    prisma.bot.findMany({ include: { template: true }, orderBy: { name: 'asc' } }),
    prisma.job.findMany({
      where: { createdAt: { gte: since } },
      include: { bot: { include: { template: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const statByBot = new Map<string, BotStat>();
  for (const b of bots) {
    statByBot.set(b.id, {
      botId: b.id,
      botName: b.name,
      pool: b.template.poolType,
      templateName: b.template.name,
      enabled: b.enabled,
      runs: 0,
      succeeded: 0,
      failed: 0,
      other: 0,
      latestStatus: null,
      lastResultSummary: null,
      errorSamples: [],
    });
  }

  for (const j of jobs) {
    const s = statByBot.get(j.botId);
    if (!s) continue;
    s.runs += 1;
    s.latestStatus = j.status; // jobs are asc → ends on the most recent run
    if (j.status === 'succeeded') {
      s.succeeded += 1;
      const summary = summarizeResult(j.result);
      if (summary) s.lastResultSummary = summary;
    } else if (j.status === 'failed') {
      s.failed += 1;
      if (j.error && s.errorSamples.length < MAX_ERR_SAMPLES && !s.errorSamples.includes(j.error)) {
        s.errorSamples.push(j.error.slice(0, 300));
      }
    } else {
      s.other += 1;
    }
  }

  const all = [...statByBot.values()];
  const ran = all.filter((s) => s.runs > 0);
  // "failing" = currently broken (most recent run failed), NOT merely failed
  // once in the window — a bot that failed then recovered shouldn't generate a
  // fix recommendation.
  const failing = all.filter((s) => s.latestStatus === 'failed').sort((a, b) => b.failed - a.failed);
  const totals = {
    bots: all.length,
    ran: ran.length,
    idle: all.length - ran.length,
    runs: all.reduce((n, s) => n + s.runs, 0),
    succeeded: all.reduce((n, s) => n + s.succeeded, 0),
    failed: all.reduce((n, s) => n + s.failed, 0),
  };

  return {
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    totals,
    bots: all,
    failing,
    lessonsLearned: null,
  };
}

// ---- DigestRun persistence -------------------------------------------------

/** Fetch the most recent stored DigestRun (for yesterday's context). */
export async function getLastDigestRun(): Promise<DigestRunRecord | null> {
  const row = await prisma.digestRun.findFirst({ orderBy: { windowEnd: 'desc' } });
  if (!row) return null;
  return {
    id: row.id,
    windowEnd: row.windowEnd,
    failingBots: row.failingBots as unknown as BotFailSnapshot[],
    lessonsLearned: row.lessonsLearned,
    createdAt: row.createdAt,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Persist a digest snapshot so tomorrow's run can compare.
 * Upserts on windowEnd so manual re-runs overwrite the same slot.
 */
export async function saveDigestRun(digest: Digest): Promise<void> {
  const failingBots: BotFailSnapshot[] = digest.failing.map((s) => ({
    botId: s.botId,
    botName: s.botName,
    pool: s.pool,
    errorSamples: s.errorSamples,
    lessonText: null,
  }));

  // Best-effort: extract per-bot lesson text from the markdown response so
  // tomorrow we can show Claude exactly what was recommended for each bot.
  if (digest.lessonsLearned) {
    for (const snap of failingBots) {
      const pattern = new RegExp(`\\*\\*${escapeRegex(snap.botName)}\\*\\*[^\n]*`, 'i');
      const m = digest.lessonsLearned.match(pattern);
      if (m) snap.lessonText = m[0];
    }
  }

  await prisma.digestRun.upsert({
    where: { windowEnd: new Date(digest.windowEnd) },
    create: {
      windowEnd: new Date(digest.windowEnd),
      failingBots: failingBots as unknown as object,
      lessonsLearned: digest.lessonsLearned,
    },
    update: {
      failingBots: failingBots as unknown as object,
      lessonsLearned: digest.lessonsLearned,
    },
  });
}

// ---- AI lessons learned ----------------------------------------------------

/**
 * Ask Claude for an advisory "lessons learned" — likely cause + recommended fix
 * per failing bot, with recovery acknowledgements for bots that were failing
 * yesterday and succeeded today. Returns null when there's nothing to say.
 */
export async function generateLessonsLearned(
  digest: Digest,
  previousRun?: DigestRunRecord | null,
): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;

  const nowFailingIds = new Set(digest.failing.map((s) => s.botId));

  // Bots that were failing yesterday but aren't today (recovered).
  const recovered = previousRun
    ? previousRun.failingBots.filter((snap) => !nowFailingIds.has(snap.botId))
    : [];

  if (digest.failing.length === 0 && recovered.length === 0) return null;

  const lines: string[] = [];

  if (digest.failing.length > 0) {
    lines.push('**Currently failing bots:**');
    for (const s of digest.failing) {
      const errs = s.errorSamples.length ? s.errorSamples.join(' | ') : '(no error text captured)';
      const prev = previousRun?.failingBots.find((p) => p.botId === s.botId);
      const dayCount = prev ? ' [also failed yesterday' + (prev.lessonText ? ` — previous recommendation: ${prev.lessonText}` : '') + ']' : '';
      lines.push(`- ${s.botName} [pool=${s.pool}, template=${s.templateName}]${dayCount} — errors: ${errs}`);
    }
  }

  if (recovered.length > 0) {
    lines.push('\n**Recovered since yesterday\'s report:**');
    for (const snap of recovered) {
      const prevErrs = snap.errorSamples.slice(0, 2).join(' | ') || '(none)';
      const prevLesson = snap.lessonText ?? 'none recorded';
      lines.push(`- ${snap.botName} [pool=${snap.pool}] — was failing (errors: ${prevErrs}), succeeded today. Yesterday's recommendation: ${prevLesson}`);
    }
  }

  const prompt = `Here is today's Hive bot fleet status:\n\n${lines.join('\n')}\n\nFor each **currently failing** bot:\n- Give a one-line likely cause and a concrete fix.\n- If it also failed yesterday with the same lesson given, note whether the fix may not have been applied yet or if it's a different issue.\n\nFor each **recovered** bot:\n- Give a one-line confirmation of what likely fixed it, based on the previous errors and recommendation.\n\nFormat as a markdown bullet per bot:\n- Failing: "**Bot name** — cause. Fix: …"\n- Recovered: "**Bot name** ✓ — [what worked / why it recovered]"\n\nPrefer config/operational fixes (missing API key, wrong exchange, Docker not running, out-of-season sport, wrong URL). Do not suggest enabling live trading. Be specific and brief.`;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: env.HIVE_BOT_BUILDER_MODEL,
    max_tokens: 1500,
    system:
      'You are an SRE assistant reviewing a fleet of automation bots day over day. You give terse, actionable, recommend-only guidance and acknowledge when previous recommendations appear to have worked.',
    messages: [{ role: 'user', content: prompt }],
  });
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ---- rendering -------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// Human-readable timestamp in US Eastern, e.g. "Jun 12, 2026, 7:30 AM EDT".
function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

// Minimal markdown → HTML for the AI section (bold + line breaks only).
function mdToHtml(md: string): string {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/\n/g, '<br>');
}

export function renderDigestText(d: Digest): string {
  const t = d.totals;
  const head = `Hive daily report\n${fmtWhen(d.windowStart)} → ${fmtWhen(d.windowEnd)}\n\n${t.runs} runs across ${t.ran}/${t.bots} bots — ${t.succeeded} ok, ${t.failed} failed, ${t.idle} idle.\n`;
  const rows = d.bots
    .map((s) => `${s.pool}/${s.botName}: ${s.runs} runs (${s.succeeded} ok, ${s.failed} fail)` +
      (s.lastResultSummary ? ` — ${s.lastResultSummary}` : s.runs === 0 ? ' — no runs' : '') +
      (s.latestStatus === 'failed' && s.errorSamples.length ? ` — ERR: ${s.errorSamples[0]}` : ''))
    .join('\n');
  const ll = d.lessonsLearned ? `\n\nLessons learned\n${d.lessonsLearned}` : '';
  return `${head}\n${rows}${ll}\n`;
}

export function renderDigestHtml(d: Digest): string {
  const t = d.totals;
  const stat = (label: string, val: number | string, color: string) =>
    `<td style="padding:8px 14px;text-align:center"><div style="font-size:22px;font-weight:700;color:${color}">${val}</div><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#9a9a9a">${esc(label)}</div></td>`;

  const row = (s: BotStat) => {
    const ratePct = s.runs ? Math.round((s.succeeded / s.runs) * 100) : null;
    const broken = s.latestStatus === 'failed';
    const status =
      s.runs === 0 ? '<span style="color:#9a9a9a">no runs</span>'
      : broken ? '<span style="color:#f87171">failing</span>'
      : s.failed === 0 ? `<span style="color:#34d399">${ratePct}% ok</span>`
      : `<span style="color:#fbbf24">recovered (${ratePct}% ok)</span>`;
    const detail = broken && s.errorSamples.length
      ? `<span style="color:#f87171">${esc(s.errorSamples[0])}</span>`
      : s.lastResultSummary ? esc(s.lastResultSummary) : '<span style="color:#9a9a9a">—</span>';
    return `<tr style="border-top:1px solid #2a2a2a">
      <td style="padding:8px 10px"><span style="display:inline-block;font-size:10px;text-transform:uppercase;color:#9a9a9a">${esc(s.pool)}</span><br><strong style="color:#eaeaea">${esc(s.botName)}</strong></td>
      <td style="padding:8px 10px;text-align:center;color:#cfcfcf">${s.runs}</td>
      <td style="padding:8px 10px;text-align:center">${status}</td>
      <td style="padding:8px 10px;color:#cfcfcf;font-size:12px">${detail}</td>
    </tr>`;
  };

  const lessons = d.lessonsLearned
    ? `<h2 style="font-size:15px;color:#fbbf24;margin:24px 0 8px">Lessons learned</h2>
       <div style="background:#161616;border:1px solid #2a2a2a;border-radius:8px;padding:14px;font-size:13px;line-height:1.6;color:#dcdcdc">${mdToHtml(d.lessonsLearned)}</div>`
    : d.failing.length === 0
      ? `<p style="color:#34d399;font-size:13px;margin-top:20px">✓ No bots are currently failing — everything that ran is healthy on its latest run.</p>`
      : '';

  return `<div style="background:#0a0a0a;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#eaeaea">
    <div style="max-width:680px;margin:0 auto">
      <div style="font-family:ui-monospace,Menlo,monospace;font-weight:700;color:#fbbf24;font-size:18px">🐝 HIVE — Daily Report</div>
      <div style="color:#9a9a9a;font-size:12px;margin-top:2px">${esc(fmtWhen(d.windowStart))} → ${esc(fmtWhen(d.windowEnd))}</div>
      <table style="margin:16px 0;background:#161616;border:1px solid #2a2a2a;border-radius:8px;border-collapse:separate"><tr>
        ${stat('runs', t.runs, '#eaeaea')}${stat('ok', t.succeeded, '#34d399')}${stat('failed', t.failed, t.failed ? '#f87171' : '#eaeaea')}${stat('bots ran', `${t.ran}/${t.bots}`, '#fbbf24')}
      </tr></table>
      <table style="width:100%;border-collapse:collapse;background:#101010;border:1px solid #2a2a2a;border-radius:8px;overflow:hidden">
        <tr style="background:#161616"><th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#9a9a9a">Bot</th><th style="padding:8px 10px;font-size:11px;text-transform:uppercase;color:#9a9a9a">Runs</th><th style="padding:8px 10px;font-size:11px;text-transform:uppercase;color:#9a9a9a">Health</th><th style="padding:8px 10px;text-align:left;font-size:11px;text-transform:uppercase;color:#9a9a9a">Latest result / error</th></tr>
        ${d.bots.map(row).join('')}
      </table>
      ${lessons}
      <p style="color:#6a6a6a;font-size:11px;margin-top:20px">Automated by Hive. Recommendations are advisory — no bots were changed.</p>
    </div>
  </div>`;
}
