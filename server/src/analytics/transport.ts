/** Small adapter for PostHog's supported HTTP batch API. No automatic SDK properties or browser capture. */
export interface PostHogEvent { uuid: string; event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown>; }
export class AnalyticsTransport {
  private queue: { event: PostHogEvent; tries: number }[] = [];
  private flushing = false;
  constructor(private token: string, private host: string, private send: typeof fetch = fetch) {}
  enqueue(event: PostHogEvent): void {
    if (this.queue.length >= 2000) return; // Analytics can never exhaust the application's memory.
    this.queue.push({ event, tries: 0 });
  }
  forget(distinctId: string): void { this.queue = this.queue.filter(e => e.event.distinct_id !== distinctId); }
  async flush(): Promise<void> {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue.splice(0,100);
    try {
      const response = await this.send(this.host+'/batch/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.token, batch: batch.map(e => e.event) }),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok && (response.status === 429 || response.status >= 500)) throw new Error('Retry');
      // Permanent errors do not affect product actions; never log event bodies or tokens.
    } catch {
      this.queue.unshift(...batch.filter(e => ++e.tries <= 3));
      this.queue = this.queue.slice(0,2000);
    } finally { this.flushing = false; }
  }
}
