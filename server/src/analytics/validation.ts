import { ANALYTICS_PRIVACY_VERSION, AnalyticsProperties, ClientAnalyticsEvent, CLIENT_EVENTS, ELEMENTS, SCREENS, UUID } from './contract';
export function analyticsAllowed(configured: boolean, user: { hasAgreedToRules?: boolean; legalVersion?: string; isBanned?: boolean } | null, excluded: boolean): boolean {
  return Boolean(configured && !excluded && user?.hasAgreedToRules && !user.isBanned && user.legalVersion === ANALYTICS_PRIVACY_VERSION);
}
export function cleanProperties(value: unknown): AnalyticsProperties {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const output: AnalyticsProperties = {};
  if (SCREENS.includes(raw.screen as any)) output.screen = raw.screen as any;
  if (ELEMENTS.includes(raw.element as any)) output.element = raw.element as any;
  for (const [key, max] of [['active_ms',120000],['filters_count',20],['answered_count',8]] as const) {
    const n = raw[key]; if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max) output[key] = Math.floor(n);
  }
  if (typeof raw.completed === 'boolean') output.completed = raw.completed;
  return output;
}
export function cleanClientBatch(input: unknown, now = Date.now()): ClientAnalyticsEvent[] {
  if (!Array.isArray(input) || !input.length || input.length > 40) throw new Error('Invalid batch');
  const seen = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw !== 'object' || !UUID.test(raw.id) || !UUID.test(raw.session_id) || !CLIENT_EVENTS.includes(raw.event) || typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at > now + 60000 || raw.at < now - 3600000) throw new Error('Invalid event');
    const properties = cleanProperties(raw.properties);
    if (!properties.screen) throw new Error('Missing screen');
    if (raw.event === 'gulyai_screen_active' && (!properties.active_ms || properties.active_ms > 120000)) throw new Error('Invalid duration');
    if (['gulyai_element_seen','gulyai_element_clicked'].includes(raw.event) && !properties.element) throw new Error('Missing element');
    if (seen.has(raw.id)) return null; seen.add(raw.id);
    // The caller cannot add a distinct_id, IP, user profile properties, or server-only success events.
    return { id: raw.id, event: raw.event, session_id: raw.session_id, at: raw.at, properties };
  }).filter(Boolean) as ClientAnalyticsEvent[];
}
