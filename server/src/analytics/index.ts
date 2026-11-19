import { randomUUID } from 'crypto';
import { Express, Response } from 'express';
import { User } from '../models/User';
import { telegramAuthMiddleware, AuthenticatedRequest } from '../middleware/telegramAuth';
import { rateLimit } from '../middleware/security';
import { AnalyticsProperties, SERVER_EVENTS, ServerEventName, UUID, SCREEN_LABELS, ELEMENT_LABELS } from './contract';
import { analyticsAllowed, cleanClientBatch, cleanProperties } from './validation';
import { AnalyticsTransport, PostHogEvent } from './transport';

let transport: AnalyticsTransport | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
const identities = new Map<number, { id: string | null; until: number }>();
const recent = new Map<string, number>();
export function analyticsConfigured(): boolean { return process.env.POSTHOG_ENABLED === '1' && /^phc_[a-zA-Z0-9_-]+$/.test(process.env.POSTHOG_PROJECT_TOKEN || '') && process.env.POSTHOG_HOST === 'https://eu.i.posthog.com'; }
function excluded(id: number): boolean { return [process.env.ADMIN_TELEGRAM_IDS,process.env.POSTHOG_EXCLUDE_TELEGRAM_IDS].some(v => (v || '').split(',').map(Number).includes(id)); }
export function analyticsAvailableFor(id: number): boolean { return analyticsConfigured() && !excluded(id); }
export function analyticsEnabledFor(user: any): boolean { return analyticsAllowed(analyticsConfigured(), user, excluded(user?.telegramId)); }
function getTransport(): AnalyticsTransport | null {
  if (!analyticsConfigured()) return null;
  if (!transport) {
    transport = new AnalyticsTransport(process.env.POSTHOG_PROJECT_TOKEN!, process.env.POSTHOG_HOST!);
    flushTimer = setInterval(() => { void transport?.flush(); },10000); flushTimer.unref();
  }
  return transport;
}
export function invalidateAnalyticsUser(id: number): void { identities.delete(id); }
export async function forgetAnalyticsUser(id: number): Promise<void> {
  const record = await User.findOne({ telegramId: id }, { analyticsId: 1 }).lean();
  if (record?.analyticsId) transport?.forget(record.analyticsId);
  identities.delete(id);
}
async function identity(id: number): Promise<string | null> {
  if (!analyticsConfigured() || excluded(id)) return null;
  const hit = identities.get(id); if (hit && hit.until > Date.now()) return hit.id;
  const user = await User.findOne({ telegramId: id }, { analyticsId:1, telegramId:1, legalVersion:1, hasAgreedToRules:1, isBanned:1 }).lean();
  let anonymousId: string | null = null;
  if (analyticsEnabledFor(user)) {
    if (user?.analyticsId && UUID.test(user.analyticsId)) anonymousId = user.analyticsId;
    else {
      const updated = await User.findOneAndUpdate({ telegramId:id, analyticsId: { $exists:false } }, { $set: { analyticsId:randomUUID() } }, { new:true, projection:{ analyticsId:1 } }).lean();
      anonymousId = updated?.analyticsId || (await User.findOne({ telegramId:id },{analyticsId:1}).lean())?.analyticsId || null;
    }
  }
  if (identities.size > 10000) identities.clear();
  identities.set(id,{ id:anonymousId,until:Date.now()+30000 });
  return anonymousId;
}
function envelope(id: string, event: string, props: AnalyticsProperties, uuid: string = randomUUID(), at = Date.now(), session?: string): PostHogEvent {
  return { uuid,event,distinct_id:id,timestamp:new Date(at).toISOString(),properties:{...cleanProperties(props),...(props.screen ? {screen_label:SCREEN_LABELS[props.screen]} : {}),...(props.element ? {element_label:ELEMENT_LABELS[props.element]} : {}),...(session && UUID.test(session) ? { $session_id:session } : {}),$process_person_profile:false,$geoip_disable:true,$ip:null,app:'gulyai',analytics_schema:1,origin:SERVER_EVENTS.includes(event as any)?'server':'client'} };
}
/** Safe to call after a successful mutation; failures never change the business result. */
export function captureAnalytics(id: number, event: ServerEventName, props: AnalyticsProperties = {}): void {
  if (!SERVER_EVENTS.includes(event)) return;
  void identity(id).then(anon => { if (anon) getTransport()?.enqueue(envelope(anon,event,props)); }).catch(() => {});
}
export async function shutdownAnalytics(): Promise<void> { if (flushTimer) clearInterval(flushTimer); await transport?.flush(); }
export function setupAnalyticsRoutes(app: Express): void {
  app.post('/api/analytics/events', telegramAuthMiddleware as any, rateLimit({name:'analytics',windowMs:60000,max:30}), async (req: AuthenticatedRequest,res:Response) => {
    try {
      if (!analyticsConfigured() || excluded(req.telegramUser!.id)) return res.sendStatus(204);
      let events; try { events=cleanClientBatch(req.body?.events); } catch { return res.sendStatus(400); }
      const id=await identity(req.telegramUser!.id); if (!id) return res.sendStatus(204);
      const sink=getTransport();
      const now=Date.now(); if (recent.size > 40000) for(const [key,until] of recent) if(until<now) recent.delete(key);
      for(const event of events) {
        const key=id+':'+event.id; if((recent.get(key)||0)>now) continue;
        if(recent.size>=60000) break;
        recent.set(key,now+3600000);
        sink?.enqueue(envelope(id,event.event,event.properties,event.id,event.at,event.session_id));
      }
      res.sendStatus(204);
    } catch { res.sendStatus(204); }
  });
}
