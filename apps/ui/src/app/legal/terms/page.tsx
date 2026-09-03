/**
 * Placeholder on purpose.
 *
 * Terms of service are a contract, and generating plausible-sounding contract
 * language that nobody has reviewed is worse than having none: it reads as
 * binding to a customer and binds nothing. The page exists so the route and
 * the footer link are real; the text has to be written.
 */
export const metadata = { title: 'Terms — Hive' };

export default function TermsPage() {
  return (
    <article className="space-y-5">
      <h1 className="font-mono text-lg uppercase tracking-[0.1em] text-honey-500">Terms of service</h1>
      <p className="rounded border border-red-500/40 bg-red-500/10 p-3 font-mono text-xs text-red-300">
        Not yet written. This has to be drafted and reviewed before Hive is offered to customers.
        Generated placeholder terms would read as binding while binding nothing.
      </p>
      <p className="text-hive-subtle">
        What is already true and enforced in the software, which the terms will need to reflect:
        each plan has limits on bots, missions, share of shared worker capacity, and model spend per
        day; missions spend money on model calls while they run and stop thinking when an account
        reaches its daily ceiling; and you can export or delete your data at any time.
      </p>
    </article>
  );
}
