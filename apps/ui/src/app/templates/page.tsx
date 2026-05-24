'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PoolBadge } from '@/components/PoolBadge';
import type { BotTemplate } from '@/lib/types';

export default function TemplatesPage() {
  const tpls = useQuery<BotTemplate[]>({
    queryKey: ['templates'],
    queryFn: () => api.get<BotTemplate[]>('/api/templates'),
  });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Templates</h1>
        <p className="font-mono text-xs text-hive-subtle">Read-only library · seeded by API</p>
      </div>
      <div className="space-y-3">
        {tpls.data?.map((t) => (
          <div key={t.id} className="rounded-lg border border-hive-border bg-hive-surface p-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-semibold">{t.name}</h2>
                {t.description && <p className="font-mono text-xs text-hive-subtle">{t.description}</p>}
              </div>
              <PoolBadge pool={t.poolType} />
            </div>
            <details className="mt-3">
              <summary className="cursor-pointer font-mono text-xs text-hive-subtle hover:text-honey-500">
                config schema
              </summary>
              <pre className="mt-2 overflow-auto rounded border border-hive-border bg-black/40 p-2 font-mono text-[11px]">
                {JSON.stringify(t.configSchema, null, 2)}
              </pre>
            </details>
            <details className="mt-2">
              <summary className="cursor-pointer font-mono text-xs text-hive-subtle hover:text-honey-500">
                default config
              </summary>
              <pre className="mt-2 overflow-auto rounded border border-hive-border bg-black/40 p-2 font-mono text-[11px]">
                {JSON.stringify(t.defaultConfig, null, 2)}
              </pre>
            </details>
          </div>
        ))}
        {tpls.data && tpls.data.length === 0 && (
          <div className="rounded-lg border border-dashed border-hive-border p-8 text-center font-mono text-sm text-hive-subtle">
            No templates yet. Run <span className="text-honey-500">pnpm --filter @hive/api seed</span>.
          </div>
        )}
      </div>
    </div>
  );
}
