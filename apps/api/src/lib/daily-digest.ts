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

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ERR_SAMPLES = 3;

function summarizeResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result !== 'object') return String(result).slice(0, 160);
  const r = result as Record<string, unknown>;
  // Prefer a few human-meaningful keys when present, else compact JSON.
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
      lastResultSummary: null,
      errorSamples: [],
    });
  }

  for (const j of jobs) {
    const s = statByBot.get(j.botId);
    if (!s) continue; // bot deleted but job lingered
    s.runs += 1;
    if (j.status === 'succeeded') {
      s.succeeded += 1;
      const summary = summarizeResult(j.result);
      if (summary) s.lastResultSummary = summary; // jobs are asc → ends on latest
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
  const failing = all.filter((s) => s.failed > 0).sort((a, b) => b.failed - a.failed);
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

/**
 * Ask Claude for an advisory "lessons learned" — likely cause + recommended fix
 * per failing bot. Recommend-only: it never edits anything. Returns null when
 * there are no failures or no API key.
 */
export async function generateLessonsLearned(digest: Digest): Promise<string | null> {
  if (digest.failing.length === 0) return null;
  if (!env.ANTHROPIC_API_KEY) return null;

  const lines = digest.failing.map((s) => {
    const errs = s.errorSamples.length ? s.errorSamples.join(' | ') : '(no error text captured)';
    return `- ${s.botName} [pool=${s.pool}, template=${s.templateName}] — ${s.failed}/${s.runs} runs failed. Errors: ${errs}`;
  });

  const prompt = `These Hive bots failed at least once in the last 24h:\n\n${lines.join('\n')}\n\nFor EACH bot, give a one-line likely cause and a concrete recommended fix. Prefer config/operational fixes (missing API key, service offline, geo-blocked exchange, Docker not running, out-of-season data, wrong URL) over code changes. Be specific and brief. Format as a markdown bullet per bot: "**Bot name** — cause. Fix: …". Do not suggest enabling live trading or anything that spends real money.`;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: env.HIVE_BOT_BUILDER_MODEL,
    max_tokens: 1200,
    system:
      'You are an SRE assistant reviewing a fleet of automation bots. You give terse, actionable, recommend-only guidance. You never instruct anyone to enable real-money trading.',
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

// Minimal markdown → HTML for the AI section (bold + line breaks only).
function mdToHtml(md: string): string {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/\n/g, '<br>');
}

export function renderDigestText(d: Digest): string {
  const t = d.totals;
  const head = `Hive daily report\n${d.windowStart} → ${d.windowEnd}\n\n${t.runs} runs across ${t.ran}/${t.bots} bots — ${t.succeeded} ok, ${t.failed} failed, ${t.idle} idle.\n`;
  const rows = d.bots
    .map((s) => `${s.pool}/${s.botName}: ${s.runs} runs (${s.succeeded} ok, ${s.failed} fail)` +
      (s.lastResultSummary ? ` — ${s.lastResultSummary}` : s.runs === 0 ? ' — no runs' : '') +
      (s.errorSamples.length ? ` — ERR: ${s.errorSamples[0]}` : ''))
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
    const status =
      s.runs === 0 ? '<span style="color:#9a9a9a">no runs</span>'
      : s.failed === 0 ? `<span style="color:#34d399">${ratePct}% ok</span>`
      : s.succeeded === 0 ? `<span style="color:#f87171">all failed</span>`
      : `<span style="color:#fbbf24">${ratePct}% ok</span>`;
    const detail = s.errorSamples.length
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
    : d.totals.failed === 0
      ? `<p style="color:#34d399;font-size:13px;margin-top:20px">✓ No failures in the last 24h — every bot that ran came back clean.</p>`
      : '';

  return `<div style="background:#0a0a0a;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#eaeaea">
    <div style="max-width:680px;margin:0 auto">
      <div style="font-family:ui-monospace,Menlo,monospace;font-weight:700;color:#fbbf24;font-size:18px">🐝 HIVE — Daily Report</div>
      <div style="color:#9a9a9a;font-size:12px;margin-top:2px">${esc(d.windowStart.slice(0, 16))} → ${esc(d.windowEnd.slice(0, 16))} UTC</div>
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
