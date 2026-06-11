'use client';
import Link from 'next/link';
import { Wand2 } from 'lucide-react';
import { PoolBadge } from '@/components/PoolBadge';
import type { Pool } from '@/lib/types';

/**
 * Static "what is this app / what can I build" page. No data fetching — it's a
 * guide, so it renders instantly and works for any role.
 */

interface PoolInfo {
  pool: Pool;
  what: string;
  ideas: string[];
}

const POOLS: PoolInfo[] = [
  {
    pool: 'scraper',
    what: 'Pulls data from public APIs and web pages on a schedule and hands back structured JSON.',
    ideas: [
      'Scrape tonight’s MLB / NBA scores from ESPN every morning',
      'Track a product’s price on a store page and record it hourly',
      'Pull betting lines for a league from a sportsbook (needs an odds API key)',
    ],
  },
  {
    pool: 'browser',
    what: 'Drives a real headless Chrome — clicks, fills forms, screenshots — for sites that need a browser.',
    ideas: [
      'Take a full-page screenshot of any URL and save it as an artifact',
      'Log into a dashboard and capture a daily report',
      'Check that a multi-step signup flow still works end to end',
    ],
  },
  {
    pool: 'monitor',
    what: 'Lightweight uptime / health checks that flag when something is down or slow.',
    ideas: [
      'Ping a website every 5 minutes and alert if it returns non-200 or gets slow',
      'Heartbeat check that proves your whole pipeline is alive',
      'Watch an API endpoint and record latency over time',
    ],
  },
  {
    pool: 'ai_agent',
    what: 'Calls Claude / GPT / Perplexity as a building block — summarize, classify, draft, extract.',
    ideas: [
      'Summarize a block of text or an article you paste in',
      'Classify incoming items (e.g. tag support tickets by topic)',
      'Draft a daily briefing from data another bot collected',
    ],
  },
  {
    pool: 'trading',
    what: 'Market data + order placement via exchanges. Paper (simulated) by default — see the note below.',
    ideas: [
      'Take a paper portfolio snapshot of simulated balances',
      'Watch a coin across exchanges for arbitrage spreads (read-only)',
      'Place a simulated market order to test a strategy',
    ],
  },
  {
    pool: 'ci_agent',
    what: 'Runs builds, tests, and shell commands inside Docker containers. Needs a host with Docker.',
    ideas: [
      'Clone a GitHub repo and run its test suite',
      'Build a Docker image from a Dockerfile',
      'Run a shell command in a clean, isolated container',
    ],
  },
  {
    pool: 'task_runner',
    what: 'Runs Python / shell / webhook tasks directly on the worker host (no container).',
    ideas: [
      'Run a Python script on a schedule',
      'Receive a webhook and echo / transform the payload',
      'Glue step between two other bots',
    ],
  },
  {
    pool: 'mcp_host',
    what: 'Stands up MCP servers that expose your Hive bots as tools other AI clients can call.',
    ideas: [
      'Expose a set of bots as MCP tools for an external assistant',
      'Host a short-lived MCP server for a single session',
    ],
  },
];

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-hive-border bg-hive-surface p-4 ${className}`}>{children}</div>
  );
}

export default function InfoPage() {
  return (
    <div className="space-y-4 p-4 sm:space-y-6 sm:p-6">
      <div className="rounded-lg border border-hive-border bg-hive-surface px-4 py-3">
        <h1 className="text-xl font-bold sm:text-2xl">What is Hive?</h1>
        <p className="mt-1 font-mono text-xs text-hive-subtle">A GUIDE TO THE APP &amp; IDEAS FOR BOTS</p>
      </div>

      {/* Overview */}
      <Card>
        <p className="text-sm leading-relaxed text-hive-text/90">
          Hive is a <span className="text-honey-500">bot orchestration platform</span>. You create{' '}
          <strong>bots</strong> from <strong>templates</strong> (reusable recipes), and a fleet of{' '}
          <strong>workers</strong> — grouped into <strong>pools</strong> by skill — actually runs them. A bot can
          run on demand or on a <strong>schedule</strong>, and every run becomes a <strong>job</strong> with logs
          and a real result you can inspect.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            ['Template', 'A recipe — e.g. “ESPN Scoreboard Scraper”. Declares which pool runs it and what config it needs.'],
            ['Bot', 'A template filled in with your values (which league, which URL, which symbol).'],
            ['Job', 'One execution of a bot. Has a status, logs, and a JSON result.'],
            ['Schedule', 'A cron rule that runs a bot automatically (e.g. every 5 minutes).'],
          ].map(([term, desc]) => (
            <div key={term} className="rounded border border-hive-border bg-hive-bg/40 p-3">
              <div className="font-mono text-[11px] uppercase text-honey-500">{term}</div>
              <div className="mt-1 text-xs leading-snug text-hive-subtle">{desc}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Fastest way to start */}
      <Card className="border-honey-500/30">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Wand2 className="h-4 w-4 text-honey-500" /> The fastest way to make a bot
            </h2>
            <p className="mt-1 text-sm text-hive-subtle">
              Don’t know which template to pick? Describe what you want in plain English and the AI Builder
              chooses the template and fills in the config for you.
            </p>
          </div>
          <Link
            href="/bot-builder"
            className="shrink-0 rounded bg-honey-500 px-4 py-1.5 text-center text-sm font-semibold text-black hover:bg-honey-400"
          >
            Open AI Builder
          </Link>
        </div>
      </Card>

      {/* Pools + ideas */}
      <div>
        <h2 className="mb-3 text-base font-semibold">What you can build, by worker pool</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {POOLS.map((p) => (
            <Card key={p.pool}>
              <div className="flex items-center gap-2">
                <PoolBadge pool={p.pool} />
              </div>
              <p className="mt-2 text-xs leading-snug text-hive-subtle">{p.what}</p>
              <ul className="mt-3 space-y-1.5">
                {p.ideas.map((idea) => (
                  <li key={idea} className="flex gap-2 text-sm text-hive-text/90">
                    <span className="mt-1 text-honey-500">⬡</span>
                    <span>{idea}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </div>

      {/* Scheduling note */}
      <Card>
        <h2 className="text-base font-semibold">Making a bot run automatically</h2>
        <p className="mt-1 text-sm leading-relaxed text-hive-subtle">
          A bot only runs when triggered. To run it on a recurring basis, add a <strong>Schedule</strong> (a cron
          rule like <code className="rounded bg-hive-bg px-1 font-mono text-[11px] text-honey-500">*/5 * * * *</code>{' '}
          for every 5 minutes) on the bot — or from the Schedules page. The scheduler then fires it for you and each
          run shows up under Jobs with its result.
        </p>
      </Card>

      {/* Trading note */}
      <Card>
        <h2 className="text-base font-semibold">A note on Trading</h2>
        <p className="mt-1 text-sm leading-relaxed text-hive-subtle">
          Trading bots run in <span className="text-honey-500">paper (simulated) mode by default</span> — they use
          real live market prices but trade against a simulated wallet, so no real money moves. Results show up on
          the Trading page (paper wallets, trade history, audit log). Real-money trading stays off unless an
          operator explicitly enables it on the worker <em>and</em> supplies exchange API keys — it is never on by
          accident.
        </p>
      </Card>
    </div>
  );
}
