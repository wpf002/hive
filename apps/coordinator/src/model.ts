import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';
import { Semaphore } from './semaphore.js';

/** One client and one concurrency ceiling shared by every role in the process. */
let client: Anthropic | null = null;
let sem: Semaphore | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is required to run a mission');
    }
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export function modelSemaphore(): Semaphore {
  if (!sem) sem = new Semaphore(env.SWARM_MAX_CONCURRENT_MODEL_CALLS);
  return sem;
}
