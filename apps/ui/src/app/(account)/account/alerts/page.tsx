'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Alert = {
  id: string;
  channel: 'email' | 'slack';
  config: { email?: string; webhookUrl?: string };
  triggerOn: string;
  enabled: boolean;
  bot: { id: string; name: string } | null;
};

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // New alert form state
  const [channel, setChannel] = useState<'email' | 'slack'>('email');
  const [emailVal, setEmailVal] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [triggerOn, setTriggerOn] = useState<'failed' | 'failed,recovered'>('failed');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api.get('/api/alerts') as Alert[];
      setAlerts(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function toggle(alert: Alert) {
    await api.patch(`/api/alerts/${alert.id}`, { enabled: !alert.enabled });
    await load();
  }

  async function remove(id: string) {
    await api.delete(`/api/alerts/${id}`);
    setAlerts((a) => a.filter((x) => x.id !== id));
  }

  async function createAlert(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const config = channel === 'email' ? { email: emailVal } : { webhookUrl };
      await api.post('/api/alerts', { channel, config, triggerOn });
      setShowForm(false);
      setEmailVal('');
      setWebhookUrl('');
      await load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-6 font-mono text-sm text-hive-subtle">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-lg font-bold text-hive-text">Alerts</h1>
          <p className="font-mono text-xs text-hive-subtle">Get notified when your bots fail or recover.</p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          className="rounded bg-honey-500 px-3 py-1.5 text-sm font-semibold text-black hover:bg-honey-400">
          + New alert
        </button>
      </div>

      {showForm && (
        <form onSubmit={createAlert}
          className="space-y-4 rounded-lg border border-hive-border bg-hive-surface p-4">
          <div className="flex gap-3">
            {(['email', 'slack'] as const).map((c) => (
              <button key={c} type="button" onClick={() => setChannel(c)}
                className={`flex-1 rounded border py-1.5 font-mono text-sm capitalize transition-colors ${
                  channel === c
                    ? 'border-honey-500 bg-honey-500/10 text-honey-400'
                    : 'border-hive-border text-hive-subtle hover:border-honey-500/40'
                }`}>
                {c === 'email' ? '📧 Email' : '💬 Slack'}
              </button>
            ))}
          </div>

          {channel === 'email' ? (
            <label className="block">
              <span className="font-mono text-[11px] uppercase text-hive-subtle">Email address</span>
              <input type="email" value={emailVal} onChange={(e) => setEmailVal(e.target.value)} required
                className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm" />
            </label>
          ) : (
            <label className="block">
              <span className="font-mono text-[11px] uppercase text-hive-subtle">Slack webhook URL</span>
              <input type="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} required
                placeholder="https://hooks.slack.com/services/..."
                className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm" />
            </label>
          )}

          <label className="block">
            <span className="font-mono text-[11px] uppercase text-hive-subtle">Notify on</span>
            <select value={triggerOn} onChange={(e) => setTriggerOn(e.target.value as typeof triggerOn)}
              className="mt-1 w-full rounded border border-hive-border bg-hive-bg px-2 py-1.5 font-mono text-sm">
              <option value="failed">Failures only</option>
              <option value="failed,recovered">Failures + recoveries</option>
            </select>
          </label>

          {formError && (
            <div className="rounded border border-red-500/40 bg-red-500/10 p-2 font-mono text-xs text-red-300">{formError}</div>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowForm(false)}
              className="rounded border border-hive-border px-3 py-1.5 font-mono text-sm text-hive-subtle hover:text-hive-text">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 rounded bg-honey-500 px-3 py-1.5 font-semibold text-black hover:bg-honey-400 disabled:opacity-60">
              {saving ? 'Saving…' : 'Save alert'}
            </button>
          </div>
        </form>
      )}

      {alerts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-hive-border p-8 text-center font-mono text-sm text-hive-subtle">
          No alerts configured. Add one above to get notified when a bot fails.
        </div>
      ) : (
        <div className="space-y-2">
          {alerts.map((alert) => {
            const dest = alert.channel === 'email' ? alert.config.email : alert.config.webhookUrl;
            return (
              <div key={alert.id}
                className="flex items-center justify-between rounded-lg border border-hive-border bg-hive-surface p-3">
                <div className="space-y-0.5">
                  <div className="font-mono text-sm text-hive-text">
                    {alert.channel === 'email' ? '📧' : '💬'} {dest}
                  </div>
                  <div className="font-mono text-[11px] text-hive-subtle">
                    {alert.bot ? `Bot: ${alert.bot.name}` : 'All bots'} ·{' '}
                    {alert.triggerOn === 'failed,recovered' ? 'Failures + recoveries' : 'Failures only'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => void toggle(alert)}
                    className={`rounded px-2 py-0.5 font-mono text-xs ${
                      alert.enabled
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-hive-bg text-hive-subtle'
                    }`}>
                    {alert.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button onClick={() => void remove(alert.id)}
                    className="font-mono text-xs text-red-400/60 hover:text-red-400">
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
