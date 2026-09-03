/**
 * A factual description of what this system actually does with data, written
 * from the code rather than from a template.
 *
 * NOT a substitute for a reviewed privacy policy. Every statement here is
 * checkable against the implementation, which is the useful half a lawyer
 * cannot write for you; the half they must write is the jurisdictional and
 * contractual language, and inventing that would be worse than leaving it out.
 */
export const metadata = { title: 'Privacy — Hive' };

export default function PrivacyPage() {
  return (
    <article className="space-y-5">
      <h1 className="font-mono text-lg uppercase tracking-[0.1em] text-honey-500">Privacy</h1>

      <p className="rounded border border-honey-500/30 bg-honey-500/10 p-3 font-mono text-xs">
        This page describes what the software does with your data, verified against the
        implementation. It is not a completed legal policy — the jurisdictional terms still need
        review before launch.
      </p>

      <section className="space-y-2">
        <h2 className="font-mono text-xs uppercase tracking-[0.1em] text-hive-subtle">
          What is stored
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Your email address, display name, and a bcrypt hash of your password. The password itself is never stored.</li>
          <li>The bots you create and their configuration. Fields a template marks as secret are encrypted at rest with envelope encryption; they are never returned over the API and are masked in your data export.</li>
          <li>What your bots collected, the claims drawn from it, and the decisions proposed.</li>
          <li>Usage: model calls, tokens, and jobs run, aggregated per month for billing.</li>
          <li>An audit log of security-relevant actions — sign-ins, permission changes, deletions.</li>
          <li>Session records, so you can be signed out everywhere.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="font-mono text-xs uppercase tracking-[0.1em] text-hive-subtle">
          Where it goes
        </h2>
        <p>
          Text from your missions is sent to Anthropic&apos;s API, which is what analyses evidence and
          proposes decisions. Your bots fetch the URLs and feeds you configure, so those operators
          see requests from this system. Email — password resets, verification, spend warnings — is
          sent through the configured mail provider. Nothing is sold, and nothing is shared with
          anyone else.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-mono text-xs uppercase tracking-[0.1em] text-hive-subtle">
          What you can do
        </h2>
        <p>
          You can download everything your account holds as a single JSON file, and you can delete
          your account. Deletion is real: your bots, missions, findings, schedules, alerts and
          sessions are removed with it, not flagged as hidden. The audit log entry recording the
          deletion is retained, because a record of what happened has to outlive the thing it
          describes.
        </p>
      </section>
    </article>
  );
}
