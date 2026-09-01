/**
 * Process-wide ceiling on concurrent model calls.
 *
 * Each mission runs its own analyst, adversary and coordinator loops, so ten
 * busy missions would otherwise open thirty simultaneous requests. The cap is
 * about the blast radius of a spike, not throughput: everything here is
 * rate-floored already, so waiting a moment for a slot costs nothing.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}
