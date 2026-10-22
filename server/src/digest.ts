import { User, IUser, DigestFrequency } from './models/User';
import { Event } from './models/Event';
import { Place, PLACE_MOODS } from './models/Place';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';
import { isAdmin } from './news';

/**
 * Подборки от бота: «что интересного» — сходки и места. Как часто — человек выбирает в анкете:
 * каждый день (утром), на выходные (в четверг вечером, по умолчанию), раз в неделю (в понедельник), не присылать.
 * Сервер может спать (бесплатный хостинг) — поэтому у каждой рассылки есть «окно»: проснулся позже — догоняем
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MINSK = 3 * HOUR; // Минск: UTC+3 круглый год
const MAX_EVENTS = 5;

// Полночь сегодняшнего дня по Минску (в UTC) и день недели (0 — воскресенье)
const minskToday = (now = Date.now()) => {
  const local = new Date(now + MINSK);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - MINSK;
  return { midnight, weekday: local.getUTCDay() };
};

// Когда должна была уйти рассылка этого типа и до какого момента её ещё можно догнать
function currentSlot(freq: DigestFrequency, now = Date.now()): { start: number; until: number } | null {
  const { midnight, weekday } = minskToday(now);
  let slot: { start: number; until: number } | null = null;
  if (freq === 'daily') slot = { start: midnight + 10 * HOUR, until: midnight + 21 * HOUR };
  if (freq === 'weekly' && weekday === 1) slot = { start: midnight + 10 * HOUR, until: midnight + 21 * HOUR };
  if (freq === 'weekend') {
    // Четверг 17:00 — пятница 14:00
    const thursday = weekday === 4 ? midnight : weekday === 5 ? midnight - DAY : null;
    if (thursday !== null) slot = { start: thursday + 17 * HOUR, until: thursday + DAY + 14 * HOUR };
  }
  return slot && now >= slot.start && now <= slot.until ? slot : null;
}

// Какие сходки показывать: сегодня-завтра / выходные / неделя вперёд
function eventsWindow(freq: DigestFrequency, now = Date.now()): { from: Date; to: Date } {
  const { midnight, weekday } = minskToday(now);
  if (freq === 'daily') return { from: new Date(now), to: new Date(midnight + 2 * DAY) };
  if (freq === 'weekend') {
    const daysToMonday = ((8 - weekday) % 7) || 7;
    return { from: new Date(now), to: new Date(midnight + daysToMonday * DAY) };
  }
  return { from: new Date(now), to: new Date(now + 7 * DAY) };
}

const TITLES: Record<DigestFrequency, string> = {
  daily: '☀️ <b>Сегодня и завтра в Минске</b>',
  weekend: '🎉 <b>На выходные в Минске</b>',
  weekly: '🗓 <b>На неделю в Минске</b>',
  off: ''
};

const CATEGORY_EMOJI: Record<string, string> = {
  walk: '🚶', cafe_bar: '☕️', expo_cinema: '🎨', trip_outdoors: '🌲', boardgames: '🎲', sport: '🚴', talk: '🤗', support: '🫂', other: '✨'
};

const when = (d: Date) =>
  new Date(d).toLocaleString('ru-RU', { timeZone: 'Europe/Minsk', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const seats = (ev: any) => ev.participants.reduce((n: number, p: any) => n + 1 + (p.guests || 0), 0);

/**
 * Текст подборки для человека. null — показывать нечего (тогда не пишем)
 */
export async function buildDigest(user: IUser, freq: DigestFrequency, now = Date.now()): Promise<{ html: string; button: string; path: string } | null> {
  const { from, to } = eventsWindow(freq, now);
  const hiddenEvents = new Set(user.hiddenEvents || []);
  const hiddenPlaces = new Set(user.hiddenPlaces || []);

  const events = (
    await Event.find({ isActive: true, dateTime: { $gte: from, $lte: to } }).sort({ dateTime: 1 }).limit(40).lean()
  ).filter((ev: any) => ev.creator?.telegramId !== user.telegramId && !hiddenEvents.has(String(ev._id)));
  // Официальные — первыми, дальше по времени
  events.sort((a: any, b: any) => Number(isAdmin(b.creator?.telegramId)) - Number(isAdmin(a.creator?.telegramId)));
  const shownEvents = events.slice(0, MAX_EVENTS);

  const since = user.lastDigestAt ? new Date(user.lastDigestAt) : new Date(now - 7 * DAY);
  const newPlaces = (await Place.find({ createdAt: { $gt: since } }).sort({ createdAt: -1 }).limit(10).lean()).filter(
    (p: any) => !hiddenPlaces.has(String(p._id))
  );

  // Место недели — для выходных и недели, если новых мест нет. С детьми — детское
  let pick: any = null;
  if (!newPlaces.length && freq !== 'daily') {
    const wantsKids = user.goesWith === 'kids';
    const candidates = (await Place.find(wantsKids ? { kidsLevel: { $in: ['top', 'age'] } } : {}).sort({ rating: -1, createdAt: 1 }).lean()).filter(
      (p: any) => !hiddenPlaces.has(String(p._id))
    );
    if (candidates.length) pick = candidates[Math.floor(now / (7 * DAY)) % candidates.length];
  }

  if (!shownEvents.length && !newPlaces.length && freq === 'daily') return null;

  const lines: string[] = [TITLES[freq], ''];

  if (shownEvents.length) {
    lines.push('<b>Сходки</b>');
    shownEvents.forEach((ev: any) => {
      const joined = ev.participants.some((p: any) => p.telegramId === user.telegramId);
      const official = isAdmin(ev.creator?.telegramId) ? '⭐ ' : '';
      lines.push(
        `• ${official}<b>${escapeHtml(when(ev.dateTime))}</b> — ${CATEGORY_EMOJI[ev.category] || '📍'} ${escapeHtml(ev.title)} · ${escapeHtml(ev.locationName)}` +
          (joined ? ' · ✅ ты идёшь' : ` · идут ${seats(ev)}`)
      );
    });
    if (events.length > shownEvents.length) lines.push(`…и ещё ${events.length - shownEvents.length} в приложении`);
  } else {
    lines.push('Сходок пока нет — собери свою, это займёт минуту 🙂');
  }

  if (newPlaces.length) {
    lines.push('', `📍 <b>Новые места:</b> ${newPlaces.slice(0, 3).map((p: any) => escapeHtml(p.name)).join(', ')}${newPlaces.length > 3 ? ` и ещё ${newPlaces.length - 3}` : ''}`);
  } else if (pick) {
    const mood = pick.moods?.[0] ? ` ${PLACE_MOODS[pick.moods[0] as keyof typeof PLACE_MOODS]?.emoji || ''}` : '';
    const kids = pick.kidsLevel === 'top' ? ' · 👶 топ для детей' : '';
    lines.push('', `📍 <b>Место недели:</b> ${escapeHtml(pick.name)}${mood}${kids}`);
    if (pick.description) lines.push(escapeHtml(pick.description));
  }

  const saved = (user.savedPlaces || []).length;
  if (saved) lines.push('', `🔖 В сохранённых ${saved} ${saved === 1 ? 'место' : saved < 5 ? 'места' : 'мест'} — позови кого-нибудь с собой`);

  lines.push('', '<i>Как часто присылать — в анкете, раздел «Подборки».</i>');

  return shownEvents.length
    ? { html: lines.join('\n'), button: 'Смотреть сходки', path: '?tab=events' }
    : { html: lines.join('\n'), button: 'Смотреть места', path: '?tab=places' };
}

let isRunning = false;

async function sendDueDigests() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = Date.now();
    for (const freq of ['daily', 'weekend', 'weekly'] as DigestFrequency[]) {
      const slot = currentSlot(freq, now);
      if (!slot) continue;
      // «На выходные» — и для тех, кто ещё не выбирал (так по умолчанию)
      const users = await User.find({
        hasAgreedToRules: true,
        isBanned: { $ne: true },
        ...(freq === 'weekend' ? { $or: [{ digest: 'weekend' }, { digest: { $exists: false } }] } : { digest: freq }),
        $and: [{ $or: [{ lastDigestAt: { $exists: false } }, { lastDigestAt: { $lt: new Date(slot.start) } }] }]
      });
      let sent = 0;
      for (const user of users) {
        try {
          const digest = await buildDigest(user, freq, now);
          // Отмечаем в любом случае — чтобы не пытаться повторно в этом окне
          await User.updateOne({ _id: user._id }, { $set: { lastDigestAt: new Date() } });
          if (digest && (await sendTelegramMessage(user.telegramId, digest.html, digest.button, digest.path))) sent++;
        } catch (err: any) {
          console.warn(`⚠️ Подборка для ${user.telegramId}:`, err?.message || err);
        }
        await new Promise((r) => setTimeout(r, 60)); // Telegram: не больше ~30 сообщений в секунду
      }
      if (users.length) console.log(`📬 Подборки «${freq}»: отправлено ${sent} из ${users.length}`);
    }
  } finally {
    isRunning = false;
  }
}

export function startDigestLoop() {
  const run = () => sendDueDigests().catch((err) => console.warn('⚠️ Ошибка подборок:', err?.message || err));
  setTimeout(run, 60 * 1000);
  setInterval(run, 10 * 60 * 1000);
}

/**
 * /digest — автор видит свою подборку прямо сейчас (для проверки), /digest daily|weekend|weekly — конкретную
 */
export async function handleDigestCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  const m = text.match(/^\/digest\b\s*(daily|weekend|weekly)?/i);
  if (!m) return false;
  if (!isAdmin(message.from?.id)) return false;
  const user = await User.findOne({ telegramId: message.from.id });
  if (!user) {
    sendTelegramMessage(message.chat.id, 'Сначала открой приложение — создастся анкета.');
    return true;
  }
  const freq = ((m[1] || '').toLowerCase() as DigestFrequency) || (user.digest && user.digest !== 'off' ? user.digest : 'weekend');
  const digest = await buildDigest(user, freq);
  if (!digest) sendTelegramMessage(message.chat.id, `Подборка «${freq}» сейчас была бы пустой — бот её не прислал бы.`);
  else sendTelegramMessage(message.chat.id, `<i>Так выглядит подборка «${freq}»:</i>\n\n${digest.html}`, digest.button, digest.path);
  return true;
}
