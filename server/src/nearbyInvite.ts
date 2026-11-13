import { Express, Response } from 'express';
import { Schema, model, Types } from 'mongoose';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { Event, IEvent } from './models/Event';
import { User } from './models/User';
import { joinBlockReason, freeSeats } from './eventJoin';
import { eventSummaryHtml, eventAppPath, formatWhen } from './eventNotify';
import { audienceUsersQuery } from './eventAudience';
import { theirPreferencesAllow } from './preferences';
import { RecruitPing } from './recruitHelp';
import { invitePoint, isDefaultPoint, isKnownArea, nearestArea } from './utils/userLocation';
import { calculateDistanceMeters } from './utils/geoUtils';
import { escapeHtml, markCannotMessage } from './utils/telegramNotify';
import { minskDayStart } from './waveLimit';
import { NEARBY_TEXTS as T } from './texts';

/**
 * «Сходки рядом»: через полчаса после создания сходки бот зовёт тех, кто живёт недалеко.
 * Полчаса — чтобы организатор успел поправить или удалить сходку.
 *
 * Кому: район из анкеты или своя метка в пределах выбранного расстояния (по умолчанию 3 км, можно «весь Минск»);
 * кто в Минске проездом и метку не ставил — считаем от центра; район не выбран — только при «весь Минск».
 * Заходил за 21 день, подходит по условиям сходки, не организатор и не записан.
 * Сколько: не больше выбранного в день (по умолчанию 3, общим счётом с «Помощью в наборе»), не больше 30 человек
 * на сходку — сначала самые близкие. Только с 10 до 22: ночную сходку разошлём утром.
 * Настройки — в анкете, блок «Сходки рядом» (кнопка под каждым приглашением ведёт туда)
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR; // Минск: UTC+3 круглый год
const DELAY = 30 * MIN;          // ждём после создания
const MAX_WAIT = 36 * HOUR;      // старше — уже не рассылаем
const MIN_AHEAD = HOUR;          // до начала меньше часа — звать поздно
const ACTIVE_DAYS = 21;
const PER_EVENT_MAX = 30;
export const NEARBY_PER_DAY = [1, 3, 5, 0];   // 0 — сколько угодно
export const NEARBY_RADIUS_KM = [1, 3, 5, 0]; // 0 — весь Минск
const DEFAULT_PER_DAY = 3;
const DEFAULT_RADIUS_KM = 3;
// «Можно зайти на полчаса» — только там, где это правда: не кино, не выезд и не встреча вдвоём
const HALF_HOUR_OK = new Set(['walk', 'cafe', 'bar', 'restaurant', 'cafe_bar', 'boardgames', 'talk']);
export const halfHourOk = (ev: { category: string; maxParticipants?: number }) => HALF_HOUR_OK.has(ev.category) && ev.maxParticipants !== 2;

const isDaytime = (now = Date.now()) => {
  const h = new Date(now + MINSK).getUTCHours();
  return h >= 10 && h < 22;
};

const perDayOf = (u: any) => (NEARBY_PER_DAY.includes(u?.nearbyPerDay) ? (u.nearbyPerDay as number) : DEFAULT_PER_DAY);
const radiusOf = (u: any) => (NEARBY_RADIUS_KM.includes(u?.nearbyRadiusKm) ? (u.nearbyRadiusKm as number) : DEFAULT_RADIUS_KM);

// Настройки для приложения. hasPoint — знаем ли, что для человека «рядом»
export const nearbySettingsOf = (u: any) => ({
  on: u?.nearbyNotify !== false,
  perDay: perDayOf(u),
  radiusKm: radiusOf(u),
  hasPoint: Boolean(invitePoint(u))
});

/* ---------- Кому уже писали ---------- */

type PingStatus = 'sent' | 'opened' | 'undelivered';

interface INearbyPing {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  toId: number;
  status: PingStatus;
  meters?: number;
  createdAt: Date;
}

const NearbyPingSchema = new Schema<INearbyPing>(
  {
    eventId: { type: Schema.Types.ObjectId, required: true },
    toId: { type: Number, required: true },
    status: { type: String, enum: ['sent', 'opened', 'undelivered'], default: 'sent' },
    meters: { type: Number }
  },
  { timestamps: true }
);
// Одному человеку про одну сходку — один раз
NearbyPingSchema.index({ eventId: 1, toId: 1 }, { unique: true });
NearbyPingSchema.index({ toId: 1, createdAt: -1 });
NearbyPingSchema.index({ createdAt: -1 });

const NearbyPing = model<INearbyPing>('NearbyPing', NearbyPingSchema);

/* ---------- Отправка ---------- */

const tg = async (method: string, body: any): Promise<any> => {
  const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => null);
  return res ? res.json().catch(() => null) : null;
};

const appUrl = () => (process.env.MINI_APP_URL || '').replace(/\/+$/, '');

// Сколько сообщений «о сходке» человек уже получил сегодня: «Сходки рядом» и «Компания собирается» вместе
async function sentToday(ids: number[], now: number): Promise<Map<number, number>> {
  const match = { toId: { $in: ids }, createdAt: { $gte: minskDayStart(now) }, status: { $ne: 'undelivered' } };
  const group = [{ $match: match }, { $group: { _id: '$toId', n: { $sum: 1 } } }];
  const [near, recruit] = await Promise.all([NearbyPing.aggregate(group), RecruitPing.aggregate(group)]);
  const map = new Map<number, number>();
  for (const r of [...near, ...recruit]) map.set(Number(r._id), (map.get(Number(r._id)) || 0) + r.n);
  return map;
}

// Пост для Тредса: кнопка «Скопировать» вмещает 256 символов — длинное название подрезаем
function threadsPost(ev: IEvent): string {
  const link = `https://t.me/${process.env.BOT_USERNAME || 'yesminsk_app_bot'}?start=event_${ev._id}`;
  const when = formatWhen(ev.dateTime);
  const where = nearestArea(ev.location?.coordinates) || ev.locationName;
  const room = 256 - T.post('', when, where, link).length;
  const title = ev.title.length > room ? `${ev.title.slice(0, Math.max(10, room - 1)).trim()}…` : ev.title;
  return T.post(title, when, where, link).slice(0, 256);
}

// Организатору: скольких позвали, совет рассказать в Тредсе и готовый текст
async function tellHost(ev: IEvent, sent: number) {
  const post = threadsPost(ev);
  const url = appUrl();
  await tg('sendMessage', {
    chat_id: ev.creator.telegramId,
    text: T.host(escapeHtml(ev.title), sent, escapeHtml(post)),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [{ text: T.copyBtn, copy_text: { text: post } }],
        [{ text: T.threadsBtn, url: `https://www.threads.net/intent/post?text=${encodeURIComponent(post)}` }],
        ...(url ? [[{ text: T.openBtn, web_app: { url: `${url}/${eventAppPath(ev)}` } }]] : [])
      ]
    }
  });
}

async function inviteNearby(ev: IEvent, now: number) {
  // Отметку ставим первой: два сервера или перезапуск не разошлют дважды
  const claimed = await Event.updateOne({ _id: ev._id, nearbyInvitedAt: { $exists: false } }, { $set: { nearbyInvitedAt: new Date() } });
  if (!claimed.modifiedCount) return;
  if (freeSeats(ev) <= 0) return;

  const hostId = ev.creator.telegramId;
  const host = await User.findOne({ telegramId: hostId }, { gender: 1, age: 1, blockedUsers: 1, hasFacePhoto: 1, photosHidden: 1, photoOnly: 1 }).lean();
  const already = await RecruitPing.distinct('toId', { eventId: ev._id });
  const skip = [...new Set<number>([hostId, ...ev.participants.map((p) => p.telegramId), ...(ev.cancellations || []).map((c) => c.telegramId), ...already.map(Number), ...(host?.blockedUsers || [])])];

  const users = await User.find(
    {
      telegramId: { $nin: skip },
      hasAgreedToRules: true,
      isBanned: { $ne: true },
      canMessage: { $ne: false },
      nearbyNotify: { $ne: false },
      lastActiveAt: { $gte: new Date(now - ACTIVE_DAYS * DAY) },
      blockedUsers: { $ne: hostId },
      hiddenEvents: { $ne: String(ev._id) },
      // Сохранившим это место бот уже написал при создании сходки
      ...(ev.placeId ? { savedPlaces: { $ne: String(ev.placeId) } } : {}),
      ...audienceUsersQuery(ev), // пол и возраст
      $and: theirPreferencesAllow(host) // не пишем тем, кто не хочет общаться с полом или возрастом организатора
    },
    { telegramId: 1, gender: 1, age: 1, isEmpath: 1, areaName: 1, isTourist: 1, locationExact: 1, locationManual: 1, nearbyPerDay: 1, nearbyRadiusKm: 1 }
  ).lean();

  const [evLng, evLat] = ev.location.coordinates;
  const evArea = nearestArea(ev.location.coordinates);
  const near = users
    .map((u) => {
      const p = invitePoint(u);
      const meters = p ? calculateDistanceMeters(p[1], p[0], evLat, evLng) : null;
      return { u, meters, point: p };
    })
    .filter(({ u, meters }) => radiusOf(u) === 0 || (meters !== null && meters <= radiusOf(u) * 1000))
    .sort((a, b) => (a.meters ?? Infinity) - (b.meters ?? Infinity));
  if (!near.length) return;

  const today = await sentToday(near.map((x) => x.u.telegramId), now);
  const fit = near
    .filter(({ u }) => perDayOf(u) === 0 || (today.get(u.telegramId) || 0) < perDayOf(u))
    // «Только эмпаты», отказ организатора — как при записи
    .filter(({ u }) => !joinBlockReason(ev, u as any, u.telegramId))
    .slice(0, PER_EVENT_MAX);
  if (!fit.length) return;

  const url = appUrl();
  const free = freeSeats(ev);
  const body = `${eventSummaryHtml(ev)}${Number.isFinite(free) ? T.seatsLeft(free) : ''}\n\n${T.comfort}${halfHourOk(ev) ? T.halfHour : ''}`;
  let sent = 0;
  for (const { u, meters, point } of fit) {
    let ping: INearbyPing;
    try {
      ping = (await NearbyPing.create({ eventId: ev._id, toId: u.telegramId, ...(meters !== null ? { meters } : {}) })).toObject();
    } catch (err: any) {
      if (err?.code === 11000) continue;
      throw err;
    }
    const head = T.head({
      meters,
      sameArea: Boolean(evArea && !u.locationManual && isKnownArea(u.areaName) && u.areaName === evArea),
      touristCenter: Boolean(u.isTourist && point && isDefaultPoint(point))
    });
    const res = await tg('sendMessage', {
      chat_id: u.telegramId,
      text: `${head}\n\n${body}`,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(url
        ? {
            reply_markup: {
              inline_keyboard: [
                [{ text: T.openBtn, web_app: { url: `${url}/${eventAppPath(ev)}&near=${ping._id}` } }],
                [{ text: T.settingsBtn, web_app: { url: `${url}/?settings=nearby` } }]
              ]
            }
          }
        : {})
    });
    if (res?.ok) sent += 1;
    else {
      await NearbyPing.updateOne({ _id: ping._id }, { $set: { status: 'undelivered' } });
      if (res?.error_code === 403) markCannotMessage(u.telegramId);
    }
    await new Promise((r) => setTimeout(r, 60));
  }

  if (!sent) return;
  await Event.updateOne({ _id: ev._id }, { $set: { nearbyInvitedCount: sent } });
  console.log(`📍 «Сходки рядом»: «${ev.title}» — позвали ${sent}`);
  await tellHost(ev, sent);
}

let running = false;
async function runNearby() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    if (!isDaytime(now) || !process.env.TELEGRAM_BOT_TOKEN) return;
    const events = await Event.find({
      isActive: true,
      nearbyInvitedAt: { $exists: false },
      createdAt: { $lte: new Date(now - DELAY), $gte: new Date(now - MAX_WAIT) },
      dateTime: { $gt: new Date(now + MIN_AHEAD) }
    });
    for (const ev of events) {
      await inviteNearby(ev, now).catch((err) => console.warn(`⚠️ «Сходки рядом», сходка ${ev._id}:`, err?.message || err));
    }
  } finally {
    running = false;
  }
}

export function startNearbyLoop() {
  const run = () => runNearby().catch((err) => console.warn('⚠️ «Сходки рядом»:', err?.message || err));
  setTimeout(run, 4 * 60 * 1000);
  setInterval(run, 5 * 60 * 1000);
}

/* ---------- Приложение: настройки и отметка «открыл» ---------- */

export function setupNearbyRoutes(app: Express) {
  // Блок «Сходки рядом» в анкете: сохраняется сразу
  app.post('/api/users/nearby-settings', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { on, perDay, radiusKm } = req.body || {};
      const set: Record<string, any> = {};
      if (typeof on === 'boolean') set.nearbyNotify = on;
      if (NEARBY_PER_DAY.includes(perDay)) set.nearbyPerDay = perDay;
      if (NEARBY_RADIUS_KM.includes(radiusKm)) set.nearbyRadiusKm = radiusKm;
      const user = await User.findOneAndUpdate({ telegramId: req.telegramUser!.id }, { $set: set }, { new: true }).lean();
      if (!user) return res.status(400).json({ error: 'Сначала прими правила на первом экране' });
      res.json(nearbySettingsOf(user));
    } catch (err: any) {
      console.warn('⚠️ Настройки «Сходки рядом»:', err?.message || err);
      res.status(500).json({ error: 'Не получилось сохранить, попробуй ещё раз' });
    }
  });

  // Человек открыл сходку по кнопке из приглашения — для /stats
  app.post('/api/nearby/opened', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
    const id = String(req.body?.id || '');
    if (Types.ObjectId.isValid(id)) {
      await NearbyPing.updateOne({ _id: id, toId: req.telegramUser!.id, status: 'sent' }, { $set: { status: 'opened' } }).catch(() => {});
    }
    res.json({ ok: true });
  });
}

/* ---------- /stats ---------- */

export async function nearbyStatsLines(): Promise<string[]> {
  const since = new Date(Date.now() - 7 * DAY);
  const pings = await NearbyPing.find({ createdAt: { $gte: since }, status: { $ne: 'undelivered' } }, { eventId: 1, toId: 1, status: 1, createdAt: 1 }).lean();
  const [off, tuned] = await Promise.all([
    User.countDocuments({ nearbyNotify: false }),
    User.countDocuments({ nearbyNotify: { $ne: false }, $or: [{ nearbyPerDay: { $exists: true } }, { nearbyRadiusKm: { $exists: true } }] })
  ]);
  if (!pings.length && !off && !tuned) return [];
  // Записался — есть в списке сходки и записался после приглашения
  const events = await Event.find({ _id: { $in: [...new Set(pings.map((p) => String(p.eventId)))] } }, { participants: 1 }).lean();
  const byId = new Map(events.map((e) => [String(e._id), e]));
  const joined = pings.filter((p) => {
    const mine = byId.get(String(p.eventId))?.participants?.find((x) => x.telegramId === p.toId);
    return Boolean(mine && new Date(mine.joinedAt).getTime() >= new Date(p.createdAt).getTime());
  }).length;
  return [
    T.statsTitle,
    T.stats(new Set(pings.map((p) => String(p.eventId))).size, pings.length, pings.filter((p) => p.status === 'opened').length, joined),
    T.statsOff(off, tuned)
  ];
}
