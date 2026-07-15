import type { ContextIndexer } from "./ContextIndexer.ts";
import type { MemoryIndexer } from "./MemoryIndexer.ts";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

export class EmbeddingRecoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private retryIndex = 0;
  private stopped = false;

  constructor(
    private memoryIndexer: MemoryIndexer,
    private contextIndexer: ContextIndexer,
    private retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
  ) {
    const trigger = () => this.trigger();
    memoryIndexer.onProviderFailure(trigger);
    contextIndexer.onProviderFailure(trigger);
  }

  trigger(): void {
    if (this.stopped || this.timer || this.running) return;
    const delays = this.retryDelaysMs.length > 0 ? this.retryDelaysMs : RETRY_DELAYS_MS;
    const delay = delays[Math.min(this.retryIndex, delays.length - 1)]!;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runRecovery().finally(() => {
        this.running = null;
      });
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private async runRecovery(): Promise<void> {
    const [memory, context] = await Promise.all([
      this.memoryIndexer.indexAll(),
      this.contextIndexer.indexAll(),
    ]);
    const degraded = memory.providerFailed || context.providerFailed ||
      memory.missingEmbeddings > 0 || context.missingEmbeddings > 0;
    if (degraded) {
      const delays = this.retryDelaysMs.length > 0 ? this.retryDelaysMs : RETRY_DELAYS_MS;
      const maxIndex = Math.max(0, delays.length - 1);
      this.retryIndex = Math.min(this.retryIndex + 1, maxIndex);
      setTimeout(() => this.trigger(), 0);
    } else {
      this.retryIndex = 0;
    }
  }
}
