import { WorkerBase } from '@hive/worker-base-ts';
import { env } from './env.js';
import { singleCallHandler, multiProviderHandler } from './handlers.js';

export const SINGLE_TEMPLATE_NAME = 'AI Single Call';
export const MULTI_TEMPLATE_NAME = 'AI Multi-Provider Verdict';

class AiAgentWorker extends WorkerBase {
  constructor() {
    super({
      poolType: 'ai_agent',
      capacity: 4,
      maxAttempts: 1,
      apiBaseUrl: env.API_BASE_URL,
      workerAuthToken: env.WORKER_AUTH_TOKEN,
      redisUrl: env.REDIS_URL,
    });
  }

  protected async setup(): Promise<void> {
    this.register(SINGLE_TEMPLATE_NAME, singleCallHandler);
    this.register(MULTI_TEMPLATE_NAME, multiProviderHandler);
  }
}

await new AiAgentWorker().run();
