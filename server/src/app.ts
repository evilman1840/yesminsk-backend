import dns from 'dns';
import express, { Request, Response } from 'express';

// Сначала IPv4: у Render нет IPv6, и запросы к Telegram иногда ждут несколько секунд, пока IPv6 не отвалится
dns.setDefaultResultOrder('ipv4first');
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { securityHeaders, stripMongoOperators, rateLimit } from './middleware/security';
import { User, ActivityGoal, ACTIVITY_GOALS, GOES_WITH, DIGEST_FREQUENCIES, Gender, PreferredGender } from './models/User';
import { startDigestLoop } from './digest';
import { startFeedbackLoop } from './feedback';
import { Event, EventCategory, IEvent, EVENT_TAGS } from './models/Event';
import { Place } from './models/Place';
import { obfuscateCoordinates, calculateDistanceMeters } from './utils/geoUtils';
import { Reaction, ReactionType } from './models/Reaction';
import { sendLike } from './social';
import { sendTelegramMessage, userMentionHtml, escapeHtml } from './utils/telegramNotify';
import { setupTelegramBot, registerTelegramWebhook } from './bot';
import { setupNewsRoutes, isAdmin } from './news';
import { setupFundRoutes } from './fund';
import { banGuard, setupModerationRoutes, reportStopWords, BANNED_ERROR } from './moderation';
import { checkStopWords, extrasText } from './stopWords';
import { markInviteJoined } from './invites';
import { setupPlacesRoutes } from './places';
import { seedEventTemplates, setupEventTemplateRoutes, findTemplate, buildExtras } from './eventTemplates';
import { setupMeetupMetricsRoutes } from './meetupMetrics';
import { rankEvent, distanceTo, Viewer } from './eventRanking';
import { setupPhotoRoutes, cleanPhotoIds, photoUrl } from './photos';
import { setupWishRoutes, startWishLoop, onMeetupFromWish, sendWithButtons, Btn } from './wishes';
import { EVENT_MESSAGE_TEXTS, BOT_ACCESS_TEXTS } from './texts';
import { Wish, WishGroup } from './models/Wish';
import { startNudgeLoop } from './nudges';
import { startProposalLoop, setupProposalRoutes, fixAutoMeetupHosts } from './proposals';
import { setupAccountRoutes } from './account';
import { setupPlaceSuggestionRoutes, backfillPlaceAuthors } from './placeSuggestions';
import { runPlaceImports } from './placesImport';
import { startReminderLoop, notifyParticipants, eventSummaryHtml, eventAppPath, formatWhen, seatsTaken, companyNote, rsvpButtons } from './eventNotify';

dotenv.config();

import compression from 'compression';
import { avatarFor, setupAvatarRoutes, storeAvatar, isOwnAvatarLink, moveAvatarsOut, syncEventAvatars, syncAllEventAvatars } from './avatars';
import { legalVisibleQuery, removeNonConsented } from './legal';
import { registerAvatarUpload } from './photoModeration';

const app = express();
// Render стоит перед нами прокси: настоящий IP человека — в X-Forwarded-For
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(securityHeaders);
app.use(cors());
// Сжатие ответов: списки людей и сходок становятся в разы легче
app.use(compression());
// Медленные запросы — в лог Render, чтобы было видно, что тормозит
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (ms > 1500 || res.statusCode >= 500) console.log(`🐢 ${req.method} ${req.path} ${res.statusCode} ${ms} мс`);
  });
  next();
});
app.use(express.json({ limit: '5mb' })); // фото приходят уже сжатыми (~100 КБ), запас — для старых тяжёлых
// Ключи «$ne», «a.b» из тела и адреса — вырезаем, чтобы нельзя было подменить запрос к базе
app.use(stripMongoOperators);
// Частота запросов: чтение (карта тянет сотни аватарок) — щедро, изменения — строже. Вебхук Telegram не ограничиваем
const isWebhook = (req: Request) => req.path.startsWith('/api/telegram/');
app.use('/api', rateLimit({ name: 'все запросы', windowMs: 60 * 1000, max: 1500, skip: isWebhook }));
app.use('/api', rateLimit({ name: 'изменения', windowMs: 60 * 1000, max: 120, skip: (req) => req.method === 'GET' || isWebhook(req) }));
// Забаненные не могут ничего менять
app.use('/api', banGuard);

// Подключение к MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/yesminsk';
// Первое подключение не удалось (Atlas занят, сеть) — пробуем снова каждые 5 секунд.
// Без повтора сервер так и остаётся без базы, и каждый запрос ждёт 10 секунд и падает
const connectDb = (attempt = 1): Promise<void> =>
  mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 10000 }).then(() => undefined, (err: any) => {
    console.warn(`⚠️ MongoDB не подключилась (попытка ${attempt}):`, err?.message || err);
    return new Promise<void>((r) => setTimeout(r, 5000)).then(() => connectDb(attempt + 1));
  });
mongoose.connection.on('disconnected', () => console.warn('⚠️ MongoDB отключилась, переподключаемся'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB снова на связи'));
connectDb()
  .then(() => {
    console.log('✅ MongoDB успешно подключена');
    removeTestProfiles();
    runPlaceImports();
    markCompletedProfiles();
    restoreSwipeHides();
    widenFuzzyLocations();
    fixOneSeatEvents();
    fixAutoMeetupHosts();
    moveAvatarsOut().then(syncAllEventAvatars);
    backfillPlaceAuthors();
    removeNonConsented();
    seedEventTemplates();
  })
  .catch((err: any) => console.warn('⚠️ Ошибка подключения MongoDB:', err?.message || err));

// Анкеты, заполненные до пометки «анкета заполнена»: интересы выбирали — значит, форму сохраняли
async function markCompletedProfiles() {
  try {
    const res = await User.updateMany({ profileCompleted: { $exists: false }, 'goals.0': { $exists: true } }, { $set: { profileCompleted: true } });
    if (res.modifiedCount) console.log(`✅ Отмечены заполненные анкеты: ${res.modifiedCount}`);
  } catch (err: any) {
    console.warn('⚠️ Пометка заполненных анкет:', err?.message || err);
  }
}

// Сходки «на 1 место» сразу полные (организатор занимает место сам) — делаем 2
async function fixOneSeatEvents() {
  try {
    const r = await Event.updateMany({ maxParticipants: 1 }, { $set: { maxParticipants: 2 } });
    if (r.modifiedCount) console.log(`✅ Сходки на 1 место → 2: ${r.modifiedCount}`);
  } catch (err: any) {
    console.warn('⚠️ Сходки на 1 место:', err?.message || err);
  }
}

// Метки раньше смещались на 300-500 м. Тем, у кого смещение меньше 500 м и метку не ставили сами, смещаем заново на 500-800 м
async function widenFuzzyLocations() {
  try {
    const users = await User.find({ locationManual: { $ne: true }, 'locationExact.coordinates.1': { $exists: true } }, { locationExact: 1, locationFuzzy: 1 }).lean();
    let moved = 0;
    for (const u of users) {
      const [lng, lat] = u.locationExact!.coordinates;
      const f = u.locationFuzzy?.coordinates;
      if (f && f.length === 2 && calculateDistanceMeters(lat, lng, f[1], f[0]) >= 490) continue;
      await User.updateOne({ _id: u._id }, { $set: { 'locationFuzzy.coordinates': obfuscateCoordinates(lng, lat) } });
      moved++;
    }
    if (moved) console.log(`✅ Метки смещены на 500-800 м: ${moved}`);
  } catch (err: any) {
    console.warn('⚠️ Смещение меток:', err?.message || err);
  }
}

// Раньше свайп влево скрывал человека навсегда. Один раз возвращаем всех скрытых так,
// кроме пар, где была жалоба: там скрытие остаётся
async function restoreSwipeHides() {
  const KEY = 'restore-swipe-hides-2026-10-25';
  try {
    const migrations = mongoose.connection.db!.collection('migrations');
    if (await migrations.findOne({ key: KEY })) return;
    const Report = mongoose.models.Report;
    const hides = await Reaction.find({ type: 'dislike' }).lean();
    let restored = 0;
    for (const h of hides) {
      const reported = Report ? await Report.exists({ fromTelegramId: h.fromTelegramId, targetType: 'user', targetId: String(h.toTelegramId) }) : null;
      if (reported) continue;
      await User.updateOne({ telegramId: h.fromTelegramId }, { $pull: { blockedUsers: h.toTelegramId } });
      await Reaction.deleteOne({ _id: h._id });
      restored++;
    }
    await migrations.insertOne({ key: KEY, restored, at: new Date() });
    console.log(`↩️ Возвращены скрытые свайпом: ${restored} из ${hides.length}`);
  } catch (err: any) {
    console.warn('⚠️ Возврат скрытых:', err?.message || err);
  }
}

// Самое большое фото в анкете (data:-строка, ~450 КБ)
const MAX_AVATAR_CHARS = 600_000;

// Фото профиля: своё сжатое фото (JPEG/PNG/WebP) или ссылка на фото из Telegram / заглушку.
// Чужие адреса не пускаем: по ним можно узнать IP каждого, кто открыл анкету
const AVATAR_DATA_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const AVATAR_HOSTS = ['t.me', 'cdn1.telegram-cdn.org', 'cdn4.telegram-cdn.org', 'cdn5.telegram-cdn.org', 'images.unsplash.com'];
function isAllowedAvatar(value: string): boolean {
  if (value.startsWith('data:')) return AVATAR_DATA_RE.test(value);
  try {
    const url = new URL(value);
    const appHost = process.env.MINI_APP_URL ? new URL(process.env.MINI_APP_URL).host : '';
    return url.protocol === 'https:' && (AVATAR_HOSTS.includes(url.host) || url.host === appHost || url.host === 'yesminsk-app.vercel.app');
  } catch {
    return false;
  }
}

// Строка из формы: обрезаем пробелы и длину; не строка — undefined
const cleanText = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

// Точка [lat, lng] из формы: числа в разумных пределах, иначе null
function cleanLatLng(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lat, lng] = v.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lat, lng];
}

// Выдуманные анкеты из /api/users/seed — удаляем с рабочего сервера, чтобы люди не писали «пустоте»
const TEST_PROFILES = [
  'daria_minsk', 'max_oktyabr', 'alena_art', 'andrei_borovaya', 'polly_uruchye',
  'dzmitry_chelyusk', 'sveta_pobeda', 'ilya_zyba', 'olga_komarovka', 'evgeny_vostok'
].map((username, i) => ({ telegramId: 90000001 + i, username }));

async function removeTestProfiles() {
  if (process.env.ALLOW_SEED === 'true') return; // при разработке тестовые анкеты нужны
  try {
    const result = await User.deleteMany({ $or: TEST_PROFILES });
    if (result.deletedCount) {
      const ids = TEST_PROFILES.map((p) => p.telegramId);
      await Reaction.deleteMany({ $or: [{ fromTelegramId: { $in: ids } }, { toTelegramId: { $in: ids } }] });
      console.log(`🧹 Удалены тестовые анкеты: ${result.deletedCount}`);
    }
  } catch (err: any) {
    console.warn('⚠️ Не удалось удалить тестовые анкеты:', err?.message || err);
  }
}

// Строгое извлечение string из req.params (устраняет TS2345 на Render)
const getParamId = (id: unknown): string => {
  if (Array.isArray(id)) return String(id[0] || '').trim();
  return String(id || '').trim();
};

// ==========================================
// 1. ПРОФИЛЬ ТЕКУЩЕГО ПОЛЬЗОВАТЕЛЯ («Я»)
// ==========================================
// Новая анкета из данных Telegram (по умолчанию — центр Минска, метка со смещением)
function newUserFields(tgUser: any) {
  const defaultLng = 27.5615;
  const defaultLat = 53.9045;
  return {
    telegramId: tgUser.id,
    firstName: tgUser.first_name,
    lastName: tgUser.last_name,
    username: tgUser.username,
    avatarUrl: tgUser.photo_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=400',
    goal: 'walk',
    age: 25,
    gender: 'not_specified',
    preferredGender: 'all',
    preferredAgeRange: { min: 18, max: 99 },
    hasAgreedToRules: false,
    locationExact: { type: 'Point', coordinates: [defaultLng, defaultLat] },
    locationFuzzy: { type: 'Point', coordinates: obfuscateCoordinates(defaultLng, defaultLat) },
    areaName: 'Немига / Центр',
    isTourist: false,
    blockedUsers: [],
    ...(tgUser.allows_write_to_pm ? { canMessage: true } : {})
  };
}

app.get('/api/users/me', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    let user = await User.findOne({ telegramId: tgUser.id });

    // До согласия с Соглашением и Политикой ничего не сохраняем: отдаём черновик в памяти,
    // запись в базе появится после «Выходим гулять!» (agree-rules)
    const isDraft = !user;
    if (!user) {
      user = new User(newUserFields(tgUser));
    } else {
      // Без save(): старая анкета с полем, которое не проходит проверку схемы, не должна ронять вход
      user.lastActiveAt = new Date();
      const set: Record<string, any> = { lastActiveAt: user.lastActiveAt };
      // Завёл или сменил @username в Telegram — запоминаем (иначе ему нельзя написать)
      if ((tgUser.username || '') !== (user.username || '')) {
        user.username = tgUser.username || undefined;
        set.username = tgUser.username || '';
      }
      // Фото из Telegram (не своё загруженное): ссылка меняется, когда человек меняет фото в Telegram — обновляем
      if (tgUser.photo_url && user.avatarUrl !== tgUser.photo_url && /^https:\/\/t\.me\/i\/userpic\//.test(user.avatarUrl || '')) {
        user.avatarUrl = tgUser.photo_url;
        set.avatarUrl = tgUser.photo_url;
      }
      await User.updateOne({ _id: user._id }, { $set: set });
      if (set.avatarUrl) syncEventAvatars(user.telegramId, set.avatarUrl).catch(() => {});
    }
    // Telegram сообщает, разрешил ли человек боту писать
    if (!isDraft && tgUser.allows_write_to_pm && user.canMessage !== true) {
      user.canMessage = true;
      user.botBlockedAt = undefined;
      await User.updateOne({ _id: user._id }, { $set: { canMessage: true }, $unset: { botBlockedAt: 1 } });
    }

    const userObj: any = user.toObject ? user.toObject() : { ...user };
    const exact = user.locationExact?.coordinates;
    const fuzzy = user.locationFuzzy?.coordinates;
    if (exact && exact.length === 2) {
      userObj.coordinates = [exact[1], exact[0]]; // [lat, lng]
    } else if (fuzzy && fuzzy.length === 2) {
      userObj.coordinates = [fuzzy[1], fuzzy[0]];
    } else {
      userObj.coordinates = [53.9045, 27.5615];
    }
    // Где тебя видят другие: смещённая метка или та, что поставил сам
    if (fuzzy && fuzzy.length === 2) userObj.shownCoordinates = [fuzzy[1], fuzzy[0]];
    userObj.locationManual = Boolean(user.locationManual);
    userObj.photos = (user.photos || []).map(photoUrl); // ещё фото в анкете — адресами
    userObj.avatarUrl = avatarFor(user.telegramId, user.avatarUrl);
    userObj.isAdmin = isAdmin(user.telegramId); // модератор: может удалять любые сходки

    res.json(userObj);
  } catch (err: any) {
    console.warn('⚠️ /api/users/me:', err?.message || err);
    res.status(500).json({ error: 'Ошибка получения профиля' });
  }
});

// Человек разрешил боту писать (системное окно в мини-приложении) — бот сразу пишет, чтобы появился диалог
app.post('/api/users/bot-access', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const myId = req.telegramUser!.id;
    if (!req.body?.allowed) return res.sendStatus(204);
    const before = await User.findOneAndUpdate({ telegramId: myId }, { $set: { canMessage: true }, $unset: { botBlockedAt: 1 } });
    // Приветствие — только если раньше бот не мог писать (чтобы не дублировать)
    if (before && before.canMessage !== true) sendTelegramMessage(myId, BOT_ACCESS_TEXTS.welcome, 'Открыть «ГУЛЯЙ!»');
    res.sendStatus(204);
  } catch {
    res.sendStatus(500);
  }
});

// Принять новую редакцию Соглашения и Политики (зарегистрированные раньше)
app.post('/api/users/accept-legal', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const version = String(req.body?.version || '').slice(0, 20);
    if (!version) return res.status(400).json({ error: 'Нет версии' });
    await User.updateOne({ telegramId: req.telegramUser!.id }, { $set: { legalVersion: version, legalAcceptedAt: new Date() } });
    res.sendStatus(204);
  } catch (err: any) {
    console.warn('⚠️ /api/users/accept-legal:', err?.message || err);
    res.status(500).json({ error: 'Не получилось сохранить' });
  }
});

// Онбординг: согласие с правилами
app.post('/api/users/agree-rules', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const legalVersion = String(req.body?.legalVersion || '').slice(0, 20);
    // Запись создаём только сейчас, после согласия
    if (!(await User.exists({ telegramId: tgUser.id }))) await User.create(newUserFields(tgUser));
    const user = await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { hasAgreedToRules: true, ...(legalVersion ? { legalVersion, legalAcceptedAt: new Date() } : {}) },
      { new: true }
    );
    // Пришёл по приглашению друга — благодарим того, кто позвал
    markInviteJoined(tgUser.id, user?.firstName || tgUser.first_name).catch(() => {});
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления правил' });
  }
});

// ==========================================
// 2. ОБНОВЛЕНИЕ ПРОФИЛЯ ПОЛЬЗОВАТЕЛЯ
// ==========================================
const handleUpdateProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const {
      name,
      firstName,
      age,
      gender,
      preferredGender,
      preferredAgeRange,
      bio,
      goal,
      goals,
      customGoal,
      goesWith,
      digest,
      isEmpath,
      coordinates,
      areaName,
      isTourist,
      avatarUrl,
      isProfileActive,
      isGuide,
      guideAbout,
      photos,
      ageConfirmed,
      genderConfirmed
    } = req.body;

    const updateData: any = {};
    // Ещё до 5 фото в анкете (id из /api/photos)
    if (cleanPhotoIds(photos)) updateData.photos = cleanPhotoIds(photos);
    const cleanName = cleanText(firstName || name, 40);
    if (cleanName) updateData.firstName = cleanName;
    if (avatarUrl && !isOwnAvatarLink(String(avatarUrl))) {
      // Защита базы от огромных фото (приложение сжимает их до ~100 КБ)
      if (String(avatarUrl).length > MAX_AVATAR_CHARS) {
        return res.status(413).json({ error: 'Фото слишком большое. Загрузи его ещё раз, приложение сожмёт автоматически' });
      }
      if (typeof avatarUrl !== 'string' || !isAllowedAvatar(avatarUrl)) {
        return res.status(400).json({ error: 'Это фото не подходит. Выбери фото JPEG или PNG с телефона' });
      }
      // Новое фото — в коллекцию avatars, в анкету метку
      updateData.avatarUrl = String(avatarUrl).startsWith('data:') ? await storeAvatar(tgUser.id, String(avatarUrl)) : avatarUrl;
      // Новое фото — копия в канал модерации с кнопкой «Удалить»
      if (String(updateData.avatarUrl).startsWith('avatar:')) registerAvatarUpload(tgUser.id, String(avatarUrl), String(updateData.avatarUrl).slice(7)).catch(() => {});
    }
    if (bio !== undefined) updateData.bio = cleanText(bio, 200) ?? '';
    if (ACTIVITY_GOALS.includes(goal)) updateData.goal = goal as ActivityGoal;
    if (Array.isArray(goals)) {
      const clean = [...new Set(goals.filter((g: any) => ACTIVITY_GOALS.includes(g)))] as ActivityGoal[];
      if (clean.length) {
        updateData.goals = clean;
        updateData.goal = clean[0];
      }
    }
    if (customGoal !== undefined) updateData.customGoal = String(customGoal).trim().slice(0, 30);
    if (GOES_WITH.includes(goesWith)) updateData.goesWith = goesWith;
    if (DIGEST_FREQUENCIES.includes(digest)) updateData.digest = digest;
    if (age !== undefined) {
      // ГУЛЯЙ! — только для взрослых
      if (!Number.isFinite(Number(age)) || Number(age) < 18) return res.status(400).json({ error: '«ГУЛЯЙ!» только для тех, кому 18+' });
      updateData.age = Math.min(99, Math.floor(Number(age)));
      if (ageConfirmed) updateData.ageConfirmed = true;
      // Возраст указан сам и интересы выбраны — анкету можно показывать
      if (ageConfirmed && Array.isArray(goals) && goals.length) updateData.profileCompleted = true;
    }
    if (isEmpath !== undefined) updateData.isEmpath = Boolean(isEmpath);
    if (gender && !['male', 'female', 'not_specified'].includes(gender)) return res.status(400).json({ error: 'Неизвестный пол' });
    if (gender) updateData.gender = gender as Gender;
    // Пол выбран самим человеком — больше не спрашиваем
    if (gender && genderConfirmed) updateData.genderConfirmed = true;
    if (['all', 'male', 'female'].includes(preferredGender)) updateData.preferredGender = preferredGender as PreferredGender;
    if (preferredAgeRange && typeof preferredAgeRange === 'object') {
      const min = Math.floor(Number(preferredAgeRange.min));
      const max = Math.floor(Number(preferredAgeRange.max));
      if (min >= 18 && max <= 99 && min <= max) updateData.preferredAgeRange = { min, max };
    }
    if (isTourist !== undefined) updateData.isTourist = Boolean(isTourist);
    const cleanArea = cleanText(areaName, 60);
    if (cleanArea) {
      updateData.areaName = cleanArea;
      if (/турист|проездом/i.test(cleanArea)) {
        updateData.isTourist = true;
      }
    }
    if (isProfileActive !== undefined) updateData.isProfileActive = Boolean(isProfileActive);
    if (isGuide !== undefined) updateData.isGuide = Boolean(isGuide);
    if (guideAbout !== undefined) updateData.guideAbout = String(guideAbout).slice(0, 140);

    const latLng = cleanLatLng(coordinates);
    if (latLng) {
      const [lat, lng] = latLng;
      const prev = await User.findOne({ telegramId: tgUser.id }, { locationExact: 1, locationManual: 1, locationFuzzy: 1 }).lean();
      const old = prev?.locationExact?.coordinates;
      // Человек сам поставил метку и точка почти не изменилась (сохранил анкету) — метку не трогаем
      const keepManual = prev?.locationManual && old?.length === 2 && calculateDistanceMeters(lat, lng, old[1], old[0]) < 300;
      const oldFuzzy = prev?.locationFuzzy?.coordinates;
      // Та же точка — то же смещение, чтобы метка не прыгала при каждом сохранении анкеты
      const sameSpot = old?.length === 2 && calculateDistanceMeters(lat, lng, old[1], old[0]) < 50 && oldFuzzy?.length === 2;
      updateData.locationExact = { type: 'Point', coordinates: [lng, lat] };
      if (!keepManual && !sameSpot) {
        updateData.locationFuzzy = { type: 'Point', coordinates: obfuscateCoordinates(lng, lat) };
        updateData.locationManual = false;
      }
    }

    // Тексты анкеты: проверяем только изменившиеся, чтобы не писать модератору при каждом сохранении
    const textKeys = ['firstName', 'bio', 'customGoal', 'guideAbout', 'areaName'].filter((k) => typeof updateData[k] === 'string' && updateData[k]);
    const prevTexts: any = textKeys.length ? await User.findOne({ telegramId: tgUser.id }, Object.fromEntries(textKeys.map((k) => [k, 1]))).lean() : null;
    const changedTexts = textKeys.filter((k) => prevTexts?.[k] !== updateData[k]).map((k) => updateData[k] as string);
    const stop = changedTexts.length ? checkStopWords(...changedTexts) : null;

    // Без upsert: запись появляется только после согласия с Соглашением (agree-rules)
    const updatedUser = await User.findOneAndUpdate({ telegramId: tgUser.id }, { $set: updateData }, { new: true });
    if (!updatedUser) return res.status(400).json({ error: 'Сначала прими правила на первом экране' });
    if (stop) {
      await reportStopWords(stop, 'profile', tgUser.id, changedTexts);
      if (stop.level === 'ban') return res.status(403).json({ error: BANNED_ERROR });
    }
    // Новое фото — сразу и в сходках, где человек организатор или участник
    if (updateData.avatarUrl) syncEventAvatars(tgUser.id, updateData.avatarUrl).catch((err) => console.warn('⚠️ Фото в сходках:', err?.message || err));

    const f = updatedUser?.locationFuzzy?.coordinates;
    res.json({ success: true, user: updatedUser, shownCoordinates: f?.length === 2 ? [f[1], f[0]] : null, locationManual: Boolean(updatedUser?.locationManual) });
  } catch (err: any) {
    console.warn('⚠️ Сохранение анкеты:', err?.message || err);
    res.status(500).json({ error: 'Ошибка сохранения профиля' });
  }
};

app.post('/api/users/profile', telegramAuthMiddleware as any, handleUpdateProfile);
app.put('/api/users/profile', telegramAuthMiddleware as any, handleUpdateProfile);

// ==========================================
// ДОНАТ ЗВЁЗДАМИ TELEGRAM
// ==========================================
const DONATE_AMOUNTS = [50, 100, 250, 500, 1000];

app.post('/api/donate/invoice', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const stars = Number(req.body.stars);
    if (!DONATE_AMOUNTS.includes(stars)) {
      return res.status(400).json({ error: 'Неизвестная сумма' });
    }
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(500).json({ error: 'Бот не настроен' });

    // Ссылка на оплату звёздами (валюта XTR, платёжный провайдер не нужен)
    const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Поддержать «ГУЛЯЙ!»',
        description: 'Спасибо, что помогаешь приложению жить и развиваться 💛',
        payload: `donate:${tgUser.id}:${stars}`,
        currency: 'XTR',
        prices: [{ label: 'Донат', amount: stars }]
      })
    });
    const data: any = await tgRes.json();
    if (!data.ok) return res.status(502).json({ error: data.description || 'Telegram не создал счёт' });

    res.json({ url: data.result });
  } catch (err: any) {
    res.status(500).json({ error: 'Ошибка создания доната' });
  }
});

// «⚡ Есть время»: hours = 1…6 включает статус, 0 — выключает
// «🫂 Хочется поныть» на несколько часов (0 — выключить). Видят только эмпаты
// Человек сам ставит свою метку на карте ({ coordinates: [lat, lng] }) или возвращает случайное смещение ({ reset: true })
app.post('/api/users/shown-location', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await User.findOne({ telegramId: req.telegramUser!.id });
    if (!user) return res.status(404).json({ error: 'Анкета не найдена' });
    if (req.body?.reset) {
      const exact = user.locationExact?.coordinates;
      const [lng, lat] = exact?.length === 2 ? exact : [27.5615, 53.9045];
      user.locationFuzzy = { type: 'Point', coordinates: obfuscateCoordinates(lng, lat) };
      user.locationManual = false;
    } else {
      const [lat, lng] = (Array.isArray(req.body?.coordinates) ? req.body.coordinates : []).map(Number);
      // Только Минск и пригороды
      if (!(lat >= 53.7 && lat <= 54.1 && lng >= 27.2 && lng <= 27.95)) return res.status(400).json({ error: 'Поставь метку в Минске или рядом с ним' });
      user.locationFuzzy = { type: 'Point', coordinates: [Number(lng.toFixed(6)), Number(lat.toFixed(6))] };
      user.locationManual = true;
    }
    await user.save();
    const [lng, lat] = user.locationFuzzy.coordinates;
    res.json({ shownCoordinates: [lat, lng], locationManual: user.locationManual });
  } catch {
    res.status(500).json({ error: 'Не получилось сохранить метку' });
  }
});

app.post('/api/users/vent', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const hours = Math.min(Math.max(Number(req.body.hours) || 0, 0), 6);
    const ventUntil = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
    await User.updateOne(
      { telegramId: tgUser.id },
      ventUntil ? { $set: { ventUntil, lastActiveAt: new Date() } } : { $unset: { ventUntil: 1 } }
    );
    res.json({ success: true, ventUntil });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось изменить статус' });
  }
});

app.post('/api/users/available', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const hours = Math.min(Math.max(Number(req.body.hours) || 0, 0), 6);
    const availableUntil = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
    await User.updateOne(
      { telegramId: tgUser.id },
      availableUntil ? { $set: { availableUntil, lastActiveAt: new Date() } } : { $unset: { availableUntil: 1 } }
    );
    res.json({ success: true, availableUntil });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось изменить статус' });
  }
});

// ==========================================
// 3. БЛОКИРОВКА ПОЛЬЗОВАТЕЛЯ (ЧЕРНЫЙ СПИСОК)
// ==========================================
app.post('/api/users/block', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const blockedTelegramId = req.body.blockedTelegramId ?? req.body.targetTelegramId;

    if (!blockedTelegramId || !Number.isFinite(Number(blockedTelegramId))) {
      return res.status(400).json({ error: 'Не указан ID пользователя' });
    }

    await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { $addToSet: { blockedUsers: Number(blockedTelegramId) } }
    );

    res.json({ success: true, message: 'Пользователь заблокирован' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка блокировки' });
  }
});

// ==========================================
// 4. ПОЛЬЗОВАТЕЛИ РЯДОМ (ДЛЯ КАРТЫ И ЛЕНТЫ)
// ==========================================
// Кого показывать человеку на карте и в «Людях»: общий фильтр для списка и для счётчика
function nearbyQuery(tgUser: { id: number }, currentUser: any, goal: any) {
  const query: any = {
    isProfileActive: true,
    hasAgreedToRules: true,
    profileCompleted: true, // пока человек не указал возраст и интересы, анкету не показываем
    telegramId: { $ne: tgUser.id }
  };

  // Скрытые навсегда и пропущенные свайпом (пока не прошёл срок)
  const skippedNow = (currentUser?.skipped || []).filter((s: any) => new Date(s.until).getTime() > Date.now()).map((s: any) => s.telegramId);
  const hiddenIds = [...(currentUser?.blockedUsers || []), ...skippedNow];
  if (hiddenIds.length > 0) {
    query.telegramId.$nin = hiddenIds;
  }

  // Исключаем тех, кто заблокировал меня, забаненных и скрытых после жалоб
  query.blockedUsers = { $ne: tgUser.id };
  query.isBanned = { $ne: true };
  query.hiddenByReports = { $ne: true };

  if (goal && goal !== 'all') {
    query.$or = [{ goal }, { goals: goal }];
  }

  // Уважаем предпочтения других: не показываем меня тем, кто не хочет встречаться с моим полом или возрастом
  query.$and = theirPreferencesAllow(currentUser);
  // Не принял новую редакцию Соглашения за 2 недели — анкету не показываем
  Object.assign(query, legalVisibleQuery());

  return query;
}

// Сколько всего людей в приложении (прошли приветствие, не забанены). Считаем раз в 5 минут
let appUsersCache = { at: 0, n: 0 };
async function appUsersCount() {
  if (Date.now() - appUsersCache.at > 5 * 60 * 1000) appUsersCache = { at: Date.now(), n: await User.countDocuments({ hasAgreedToRules: true, isBanned: { $ne: true } }) };
  return appUsersCache.n;
}

// Сколько анкет видно человеку всего (на карту приходят только самые активные)
app.get('/api/users/nearby-count', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const currentUser = await User.findOne({ telegramId: tgUser.id }, { blockedUsers: 1, skipped: 1, gender: 1, age: 1 }).lean();
    res.json({ total: await User.countDocuments(nearbyQuery(tgUser, currentUser, typeof req.query.goal === 'string' ? req.query.goal : undefined)), all: await appUsersCount() });
  } catch (err: any) {
    console.warn('⚠️ /api/users/nearby-count:', err?.message || err);
    res.status(500).json({ error: 'Ошибка подсчёта' });
  }
});

app.get('/api/users/nearby', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const currentUser = await User.findOne({ telegramId: tgUser.id });
    const query = nearbyQuery(tgUser, currentUser, typeof req.query.goal === 'string' ? req.query.goal : undefined);

    // Самые активные 300: анкеты лёгкие (фото — ссылкой), карта не перегружается
    const users = await User.find(query).limit(300).sort({ lastActiveAt: -1 });
    // «⚡ Свободен сейчас» — первыми в списке
    users.sort((a, b) => Number(isAvailableNow(b)) - Number(isAvailableNow(a)));
    const flags = await getReactionFlags(tgUser.id, users.map((u) => u.telegramId));

    res.json(users.map((u) => formatPublicUser(u, currentUser, flags.get(u.telegramId))));
  } catch (err: any) {
    console.warn('⚠️ /api/users/nearby:', err?.message || err);
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

// Можно ли мне видеть эту анкету: не забанен, не скрыт после жалоб, никто никого не заблокировал
const visibleUserQuery = (me: any, targetId: number) => ({
  telegramId: targetId,
  hasAgreedToRules: true,
  profileCompleted: true,
  isBanned: { $ne: true },
  hiddenByReports: { $ne: true },
  blockedUsers: { $ne: me?.telegramId },
  ...legalVisibleQuery(),
  ...(me?.blockedUsers?.includes(targetId) ? { _id: null } : {})
});

// Одна анкета — для ссылки «Посмотреть анкету» из сообщения бота
app.get('/api/users/:telegramId/public', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const targetId = Number(req.params.telegramId);
    if (!Number.isFinite(targetId)) return res.sendStatus(404);
    const me = await User.findOne({ telegramId: req.telegramUser!.id });
    const target = await User.findOne(visibleUserQuery(me, targetId));
    if (!target) return res.status(404).json({ error: 'Анкета скрыта или удалена' });
    const flags = await getReactionFlags(req.telegramUser!.id, [targetId]);
    res.json(formatPublicUser(target, me, flags.get(targetId)));
  } catch {
    res.status(500).json({ error: 'Не удалось загрузить анкету' });
  }
});

// «Хочу сходить»: кто ещё в группе совпадения (видят только участники группы)
app.get('/api/wishes/groups/:id/members', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = getParamId(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) return res.sendStatus(404);
    const myId = req.telegramUser!.id;
    const group = await WishGroup.findById(id);
    if (!group || !(await Wish.exists({ groupId: group._id, telegramId: myId }))) return res.sendStatus(404);
    const ids = (await Wish.find({ groupId: group._id, status: { $in: ['matched', 'fulfilled'] }, telegramId: { $ne: myId } }).lean()).map((w) => w.telegramId);
    const me = await User.findOne({ telegramId: myId });
    const others = await User.find({ ...visibleUserQuery(me, 0), telegramId: { $in: ids, $nin: me?.blockedUsers || [] } });
    const flags = await getReactionFlags(myId, others.map((u) => u.telegramId));
    res.json({
      kind: group.kind,
      sport: group.sport || null,
      eventId: group.meetupId || null,
      // Бот спросил место и его ещё не выбрали — в приложении покажем поле «Предложить место»
      askingPlace: Boolean(group.askPlaceAt && !group.proposal && group.status === 'open'),
      placeName: group.proposal?.placeName || null,
      members: others.map((u) => formatPublicUser(u, me, flags.get(u.telegramId)))
    });
  } catch {
    res.status(500).json({ error: 'Не удалось загрузить' });
  }
});

// ==========================================
// ОБЩИЕ ХЕЛПЕРЫ ДЛЯ АНКЕТ И РЕАКЦИЙ
// ==========================================
interface ReactionFlags {
  iLiked: boolean;
  likedMe: boolean;
  isMatch: boolean;
}

// Для списка людей: кого я лайкнул, кто лайкнул меня, с кем мэтч
async function getReactionFlags(myId: number, otherIds: number[]): Promise<Map<number, ReactionFlags>> {
  const map = new Map<number, ReactionFlags>();
  if (otherIds.length === 0) return map;

  const reactions = await Reaction.find({
    type: 'like',
    $or: [
      { fromTelegramId: myId, toTelegramId: { $in: otherIds } },
      { toTelegramId: myId, fromTelegramId: { $in: otherIds } }
    ]
  }).lean();

  for (const id of otherIds) map.set(id, { iLiked: false, likedMe: false, isMatch: false });
  for (const r of reactions) {
    if (r.fromTelegramId === myId) map.get(r.toTelegramId)!.iLiked = true;
    else map.get(r.fromTelegramId)!.likedMe = true;
  }
  map.forEach((f) => (f.isMatch = f.iLiked && f.likedMe));
  return map;
}

// Публичная анкета. @username отдаём только при взаимной симпатии (мэтче)
function formatPublicUser(u: any, currentUser: any, flags?: ReactionFlags) {
  const fuzzyCoords = u.locationFuzzy?.coordinates || [27.5615, 53.9045];
  let distanceMeters = 350;

  if (currentUser?.locationExact?.coordinates) {
    const [myLng, myLat] = currentUser.locationExact.coordinates;
    distanceMeters = calculateDistanceMeters(myLat, myLng, fuzzyCoords[1], fuzzyCoords[0]);
  }

  const isMatch = Boolean(flags?.isMatch);

  return {
    id: u.telegramId,
    telegramId: u.telegramId,
    firstName: u.firstName,
    username: isMatch ? u.username : undefined,
    // Жалоба «неприличное фото» — фото не показываем до решения модератора
    avatarUrl: u.photosHidden ? '' : avatarFor(u.telegramId, u.avatarUrl),
    age: u.age,
    gender: u.gender,
    goal: u.goal,
    goals: u.goals?.length ? u.goals : [u.goal],
    customGoal: u.goals?.includes('other') ? u.customGoal || '' : '',
    goesWith: u.goesWith,
    isEmpath: Boolean(u.isEmpath),
    // «Хочется поныть» — только для эмпатов (и не прошедший)
    ventUntil: currentUser?.isEmpath && u.ventUntil && new Date(u.ventUntil).getTime() > Date.now() ? u.ventUntil : undefined,
    bio: u.bio,
    areaName: u.areaName,
    isTourist: u.isTourist,
    coordinates: [fuzzyCoords[1], fuzzyCoords[0]], // [lat, lng]
    distanceMeters,
    iLiked: Boolean(flags?.iLiked),
    likedMe: Boolean(flags?.likedMe),
    isMatch,
    availableUntil: isAvailableNow(u) ? u.availableUntil : undefined,
    isGuide: Boolean(u.isGuide) && !u.isTourist,
    // Для фильтра «Были недавно» — без точного времени, только «заходил за последние 3 дня»
    activeRecently: Boolean(u.lastActiveAt && Date.now() - new Date(u.lastActiveAt).getTime() < 3 * DAY),
    guideAbout: u.isGuide && !u.isTourist ? u.guideAbout || '' : undefined,
    photos: u.photosHidden ? [] : (u.photos || []).map(photoUrl)
  };
}

// Раньше анкета по умолчанию сохраняла «возраст компании 18–45» — такие значения считаем «не указано»
const LEGACY_DEFAULT_AGE = { min: 18, max: 45 };

/**
 * Условия «их предпочтения допускают меня»: пол и возраст компании, которые человек указал в анкете
 */
function theirPreferencesAllow(me: any): any[] {
  const myGender = me?.gender;
  const myAge = Number(me?.age) || 25;
  return [
    {
      preferredGender:
        myGender === 'male' ? { $in: ['all', 'male', null] } : myGender === 'female' ? { $in: ['all', 'female', null] } : { $in: ['all', null] }
    },
    {
      $or: [
        { preferredAgeRange: { $exists: false } },
        { 'preferredAgeRange.min': LEGACY_DEFAULT_AGE.min, 'preferredAgeRange.max': LEGACY_DEFAULT_AGE.max },
        { 'preferredAgeRange.min': { $lte: myAge }, 'preferredAgeRange.max': { $gte: myAge } }
      ]
    }
  ];
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const isAvailableNow = (u: any) => Boolean(u?.availableUntil && new Date(u.availableUntil).getTime() > Date.now());

// ==========================================
// 4.1 👋 ПООБЩАТЬСЯ / 🙈 СКРЫТЬ И «НА СВЯЗИ»
// ==========================================
app.post('/api/reactions', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const targetId = Number(req.body.targetTelegramId);
    const type = req.body.type as ReactionType;

    if (!targetId || targetId === tgUser.id) {
      return res.status(400).json({ error: 'Не указан пользователь' });
    }
    if (type !== 'like' && type !== 'dislike') {
      return res.status(400).json({ error: 'Неизвестный тип реакции' });
    }

    const [me, target] = await Promise.all([
      User.findOne({ telegramId: tgUser.id }),
      User.findOne({ telegramId: targetId })
    ]);
    if (!me || !target) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // 🙈 Скрыть = больше не видим друг друга
    if (type === 'dislike') {
      await Reaction.findOneAndUpdate({ fromTelegramId: tgUser.id, toTelegramId: targetId }, { $set: { type } }, { upsert: true });
      await User.updateOne({ telegramId: tgUser.id }, { $addToSet: { blockedUsers: targetId } });
      return res.json({ success: true, isMatch: false });
    }

    const liked = await sendLike(me, target);
    if (!liked) return res.status(403).json({ error: 'Этому человеку нельзя передать привет' });
    const { isMatch } = liked;

    res.json({
      success: true,
      isMatch,
      user: formatPublicUser(target, me, { iLiked: true, likedMe: isMatch, isMatch })
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Ошибка сохранения реакции' });
  }
});

// «Отменить» в «На связи»: снимаю свой 👋. Человек пропадает из «На связи» у обоих, @username больше не видно.
// Ему ничего не пишем. Если снова нажать 👋 — снова «На связи»
app.post('/api/reactions/unmatch', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const myId = req.telegramUser!.id;
    const targetId = Number(req.body?.targetTelegramId);
    if (!Number.isSafeInteger(targetId) || targetId === myId) return res.status(400).json({ error: 'Не указан пользователь' });
    await Reaction.updateOne({ fromTelegramId: myId, toTelegramId: targetId, type: 'like' }, { $set: { type: 'unmatch' } });
    res.json({ success: true });
  } catch (err: any) {
    console.warn('⚠️ /api/reactions/unmatch:', err?.message || err);
    res.status(500).json({ error: 'Не получилось отменить' });
  }
});

// «Пропустить» (свайп влево): человек вернётся в ленту через 3 дня. { undo: true } — вернуть сразу
const SKIP_DAYS = 3;
app.post('/api/users/:telegramId/skip', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const targetId = Number(req.params.telegramId);
    if (!Number.isFinite(targetId)) return res.sendStatus(400);
    const myId = req.telegramUser!.id;
    await User.updateOne({ telegramId: myId }, { $pull: { skipped: { telegramId: targetId } } });
    if (!req.body?.undo) {
      const until = new Date(Date.now() + SKIP_DAYS * 24 * 60 * 60 * 1000);
      // Храним последние 500 пропусков
      await User.updateOne({ telegramId: myId }, { $push: { skipped: { $each: [{ telegramId: targetId, until }], $slice: -500 } } });
    }
    res.sendStatus(204);
  } catch {
    res.sendStatus(500);
  }
});

// «Хотят пообщаться» (мне нажали 👋, я ещё не ответил) и «На связи» (взаимно)
app.get('/api/reactions/inbox', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const me = await User.findOne({ telegramId: tgUser.id });

    const [likesToMe, myReactions] = await Promise.all([
      Reaction.find({ toTelegramId: tgUser.id, type: 'like' }).sort({ updatedAt: -1 }).lean(),
      Reaction.find({ fromTelegramId: tgUser.id }).lean()
    ]);

    const myReactionById = new Map(myReactions.map((r) => [r.toTelegramId, r.type]));
    const blocked = new Set(me?.blockedUsers || []);

    const likerIds = likesToMe.map((r) => r.fromTelegramId).filter((id) => !blocked.has(id));
    const likers = await User.find({ telegramId: { $in: likerIds }, blockedUsers: { $ne: tgUser.id }, isBanned: { $ne: true } });
    const likerById = new Map(likers.map((u) => [u.telegramId, u]));

    const likedMe: any[] = [];
    const matches: any[] = [];

    for (const id of likerIds) {
      const u = likerById.get(id);
      if (!u) continue;
      const mine = myReactionById.get(id);
      if (mine === 'like') {
        matches.push(formatPublicUser(u, me, { iLiked: true, likedMe: true, isMatch: true }));
      } else if (!mine) {
        likedMe.push(formatPublicUser(u, me, { iLiked: false, likedMe: true, isMatch: false }));
      }
    }

    res.json({ likedMe, matches });
  } catch (err: any) {
    res.status(500).json({ error: 'Ошибка загрузки симпатий' });
  }
});

// ==========================================
// 5. СОБЫТИЯ / СХОДКИ (EVENTS API)
// ==========================================

// Сходка для приложения. participantsCount — занятые места (с гостями), groupsCount — сколько записей
// Мест: 0 — без ограничений; организатор сам занимает место, поэтому меньше 2 не бывает
const seatsLimit = (v: any) => {
  const n = Math.max(0, Math.floor(Number(v) || 0));
  return n === 1 ? 2 : Math.min(n, 1000);
};

const isEventCreator = (ev: IEvent, viewerId: number) => Number(ev.creator.telegramId) === Number(viewerId);

const formatEvent = (ev: IEvent, viewerId: number) => {
  const mine = ev.participants.find((p) => p.telegramId === viewerId);
  return {
    id: ev._id.toString(),
    _id: ev._id.toString(),
    title: ev.title,
    description: ev.description,
    category: ev.category,
    customCategory: ev.customCategory || '',
    tags: ev.tags || [],
    locationName: ev.locationName,
    coordinates: [ev.location.coordinates[1], ev.location.coordinates[0]], // [lat, lng]
    dateTime: ev.dateTime,
    creator: {
      telegramId: ev.creator.telegramId,
      name: ev.creator.name,
      username: ev.creator.username,
      avatarUrl: avatarFor(ev.creator.telegramId, ev.creator.avatarUrl)
    },
    participantsCount: seatsTaken(ev),
    groupsCount: ev.participants.length,
    withKidsCount: ev.participants.filter((p) => p.withKids).length,
    maxParticipants: ev.maxParticipants || 0,
    isJoined: Boolean(mine),
    myGuests: mine?.guests || 0,
    myWithKids: Boolean(mine?.withKids),
    myConfirmed: Boolean(mine?.confirmedAt),
    // Кто идёт: все видят всех; Telegram участников — только организатору (чтобы написать детали)
    participants: ev.participants.map((p) => ({
      telegramId: p.telegramId,
      name: p.name,
      avatarUrl: avatarFor(p.telegramId, p.avatarUrl),
      guests: p.guests || 0,
      withKids: Boolean(p.withKids),
      confirmed: Boolean(p.confirmedAt), // «✅ Точно приду» — значок у аватарки
      ...(isEventCreator(ev, viewerId) && p.username ? { username: p.username } : {})
    })),
    placeId: ev.placeId ? String(ev.placeId) : undefined, // сходка в месте из «Мест» — покажем её в карточке места
    templateId: ev.templateId || undefined,
    durationMinutes: ev.durationMinutes || 0,
    extras: ev.extras || {},
    badges: ev.badges || [],
    photos: ev.photosHidden ? [] : (ev.photos || []).map(photoUrl),
    isPaid: Boolean(ev.isPaid),
    price: ev.isPaid && ev.price ? ev.price : undefined,
    // «⭐ От ГУЛЯЙ!» — сходки автора проекта
    isOfficial: isAdmin(ev.creator.telegramId)
  };
};

// Шаблон и его доп. поля из формы: { templateId, extras, badges } или ошибка для пользователя
async function templateFields(templateId: unknown, rawExtras: unknown) {
  const tpl = await findTemplate(templateId);
  if (!tpl) return { templateId: undefined, extras: undefined, badges: [] as string[] };
  const built = buildExtras(tpl.fields || [], rawExtras || {});
  if (built.error) return { error: built.error };
  return { templateId: tpl.key, extras: built.extras, badges: built.badges };
}

// Примерная цена в BYN: число от 0 до 10 000, иначе не указана
const cleanPrice = (v: unknown) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n <= 10000 ? Math.round(n * 100) / 100 : undefined;
};

const cleanDuration = (v: unknown) => Math.min(24 * 60, Math.max(0, Math.round(Number(v) || 0)));

const EVENT_CATEGORIES = ['walk', 'cafe_bar', 'expo_cinema', 'trip_outdoors', 'boardgames', 'sport', 'talk', 'support', 'other'];

// Дата сходки: настоящая дата не дальше чем через год
const cleanEventDate = (v: unknown) => {
  const d = new Date(v as any);
  const t = d.getTime();
  return Number.isFinite(t) && t > Date.now() - DAY && t < Date.now() + 366 * DAY ? d : null;
};

// Не больше 10 новых сходок в сутки от одного человека: иначе бот рассылает «собирают сходку» тысячам и Telegram считает его спамером
const EVENTS_PER_DAY = 10;

const cleanTags = (tags: unknown) =>
  Array.isArray(tags) ? [...new Set(tags.filter((t: any) => EVENT_TAGS.includes(t)))] : undefined;

// «В Лошицкий парк из твоих сохранённых собирают сходку» — тем, кто сохранил место
async function notifyPlaceSavers(event: IEvent) {
  const place = await Place.findById(event.placeId, { name: 1 }).lean();
  if (!place) return;
  const savers = await User.find(
    { savedPlaces: event.placeId, telegramId: { $ne: event.creator.telegramId }, isBanned: { $ne: true }, hasAgreedToRules: true },
    { telegramId: 1, hiddenEvents: 1 }
  ).lean();
  for (const u of savers) {
    sendTelegramMessage(
      u.telegramId,
      `🔖 В «<b>${escapeHtml(place.name)}</b>» из твоих сохранённых собирают сходку!\n\n${eventSummaryHtml(event)}\n\nПойдёшь? 👇`,
      'Открыть сходку',
      eventAppPath(event)
    );
    await new Promise((r) => setTimeout(r, 60));
  }
  if (savers.length) console.log(`🔖 Сходка в «${place.name}»: написали ${savers.length} сохранившим`);
}

// Получить список событий
app.get('/api/events', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;

    const now = Date.now();
    const me = await User.findOne({ telegramId: tgUser.id }, { hiddenEvents: 1, isEmpath: 1, goals: 1, goal: 1, locationExact: 1 }).lean();
    const mineQuery = { $or: [{ 'creator.telegramId': tgUser.id }, { 'participants.telegramId': tgUser.id }] };
    const categoryQuery = category && category !== 'all' ? { category: category as EventCategory } : {};

    // Лента: ближайшие 30 дней (начавшиеся — ещё полчаса, можно успеть подойти).
    // «Неинтересно» и «только для эмпатов» (если я не эмпат) — не показываем
    const hiddenIds = (me?.hiddenEvents || []).filter((id) => mongoose.Types.ObjectId.isValid(id));
    const feedQuery: any = {
      isActive: true,
      ...categoryQuery,
      dateTime: { $gte: new Date(now - 30 * 60 * 1000), $lte: new Date(now + 30 * DAY) },
      'creator.telegramId': { $ne: tgUser.id },
      'participants.telegramId': { $ne: tgUser.id },
      ...(hiddenIds.length ? { _id: { $nin: hiddenIds } } : {}),
      ...(me?.isEmpath ? {} : { tags: { $ne: 'empaths' } })
    };
    // Свои и куда записан — всегда, даже дальше месяца (для «⭐ Мои»); начавшиеся — ещё 4 часа
    const [feed, mine] = await Promise.all([
      Event.find(feedQuery).sort({ dateTime: 1 }).limit(200),
      Event.find({ isActive: true, ...categoryQuery, ...mineQuery, dateTime: { $gte: new Date(now - 4 * HOUR) } }).sort({ dateTime: 1 }).limit(100)
    ]);

    // Кто у меня «На связи»: я нажал 👋 и мне нажали
    const [myLikes, likesToMe] = await Promise.all([
      Reaction.distinct('toTelegramId', { fromTelegramId: tgUser.id, type: 'like' }),
      Reaction.distinct('fromTelegramId', { toTelegramId: tgUser.id, type: 'like' })
    ]);
    const toMe = new Set(likesToMe.map(Number));
    const viewer: Viewer = {
      goals: me?.goals?.length ? me.goals : me?.goal ? [me.goal] : [],
      home: me?.locationExact?.coordinates?.length === 2 ? (me.locationExact.coordinates as [number, number]) : undefined,
      matchIds: new Set(myLikes.map(Number).filter((id) => toMe.has(id))),
      now
    };

    // Порядок — по баллам (см. eventRanking.ts); приложение ещё поднимает непросмотренные
    const ranked = [...mine, ...feed].map((ev) => {
      const input = {
        dateTime: ev.dateTime,
        category: ev.category,
        location: ev.location.coordinates as [number, number],
        participantIds: ev.participants.map((p) => p.telegramId),
        seatsTaken: seatsTaken(ev),
        maxParticipants: ev.maxParticipants || 0,
        isOfficial: isAdmin(ev.creator.telegramId)
      };
      return { ev, score: rankEvent(input, viewer), distanceMeters: distanceTo(input, viewer) };
    });
    ranked.sort((a, b) => b.score - a.score || a.ev.dateTime.getTime() - b.ev.dateTime.getTime());

    res.json(ranked.map(({ ev, distanceMeters }) => ({ ...formatEvent(ev, tgUser.id), ...(distanceMeters !== null ? { distanceMeters } : {}) })));
  } catch (err: any) {
    console.warn('⚠️ /api/events:', err?.message || err);
    res.status(500).json({ error: 'Ошибка загрузки событий' });
  }
});

// Создать событие
app.post('/api/events', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const user = await User.findOne({ telegramId: tgUser.id });

    const {
      title,
      description,
      category,
      customCategory,
      tags,
      placeId,
      locationName,
      coordinates, // [lat, lng]
      dateTime,
      maxParticipants,
      templateId,
      durationMinutes,
      extras,
      photos,
      isPaid,
      price,
      wishGroupId
    } = req.body;

    const cleanTitle = cleanText(title, 100);
    const cleanDescription = cleanText(description, 600);
    const cleanLocation = cleanText(locationName, 150);
    const latLng = cleanLatLng(coordinates);
    const when = cleanEventDate(dateTime);
    if (!cleanTitle || !cleanDescription || !cleanLocation || !latLng || !when) {
      return res.status(400).json({ error: 'Заполните все обязательные поля события' });
    }
    if (category && !EVENT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Неизвестный тип сходки' });
    if ((await Event.countDocuments({ 'creator.telegramId': tgUser.id, createdAt: { $gte: new Date(Date.now() - DAY) } })) >= EVENTS_PER_DAY) {
      return res.status(429).json({ error: 'Сегодня ты уже собрал(а) много сходок. Новые можно будет создать завтра' });
    }

    const tpl = await templateFields(templateId, extras);
    if ('error' in tpl) return res.status(400).json({ error: tpl.error });

    const [lat, lng] = latLng;
    // Митинги, протесты, политика: однозначные слова — сходку не показываем, автора в бан
    const cleanCustom = category === 'other' ? String(customCategory || '').trim().slice(0, 30) : '';
    const stopTexts = [cleanTitle, cleanDescription, cleanLocation, cleanCustom, extrasText(tpl.extras)];
    const stop = checkStopWords(...stopTexts);

    const newEvent = await Event.create({
      title: cleanTitle,
      description: cleanDescription,
      category: category || 'walk',
      customCategory: cleanCustom,
      tags: cleanTags(tags) || [],
      placeId: placeId && mongoose.Types.ObjectId.isValid(String(placeId)) ? String(placeId) : undefined,
      templateId: tpl.templateId,
      durationMinutes: cleanDuration(durationMinutes),
      extras: tpl.extras,
      badges: tpl.badges,
      photos: cleanPhotoIds(photos) || [],
      isPaid: Boolean(isPaid),
      price: isPaid ? cleanPrice(price) : undefined,
      locationName: cleanLocation,
      location: {
        type: 'Point',
        coordinates: [lng, lat]
      },
      dateTime: when,
      creator: {
        telegramId: tgUser.id,
        name: user?.firstName || tgUser.first_name,
        username: user?.username || tgUser.username,
        avatarUrl: user?.avatarUrl || tgUser.photo_url || ''
      },
      participants: [
        {
          telegramId: tgUser.id,
          name: user?.firstName || tgUser.first_name,
          username: user?.username || tgUser.username,
          avatarUrl: user?.avatarUrl || tgUser.photo_url || '',
          joinedAt: new Date()
        }
      ],
      maxParticipants: seatsLimit(maxParticipants),
      isActive: stop?.level !== 'ban'
    });

    if (stop) {
      await reportStopWords(stop, 'event', tgUser.id, stopTexts, String(newEvent._id));
      if (stop.level === 'ban') return res.status(403).json({ error: BANNED_ERROR });
    }

    res.status(201).json(formatEvent(newEvent, tgUser.id));

    // Сходка в место — пишем тем, у кого оно в 🔖 сохранённых
    // Собрали по «Хочу сходить» → остальным в группе «Сходку собрали»
    if (wishGroupId) onMeetupFromWish(wishGroupId, newEvent, tgUser.id).catch((err) => console.warn('⚠️ «Хочу сходить» после сходки:', err?.message || err));
    if (newEvent.placeId) notifyPlaceSavers(newEvent).catch((err) => console.warn('⚠️ Уведомление сохранившим место:', err?.message || err));
  } catch (err: any) {
    console.warn('⚠️ Создание сходки:', err?.message || err);
    res.status(500).json({ error: 'Ошибка создания события' });
  }
});

// Скрытые сходки (ещё не прошедшие) — список в анкете, чтобы можно было вернуть
app.get('/api/events/hidden', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const me = await User.findOne({ telegramId: tgUser.id }, { hiddenEvents: 1 }).lean();
    const ids = (me?.hiddenEvents || []).filter((id) => mongoose.Types.ObjectId.isValid(id));
    const events = ids.length
      ? await Event.find({ _id: { $in: ids }, isActive: true, dateTime: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) } }).sort({ dateTime: 1 })
      : [];
    res.json(events.map((ev) => formatEvent(ev, tgUser.id)));
  } catch {
    res.status(500).json({ error: 'Ошибка загрузки скрытых сходок' });
  }
});

// «Неинтересно»: скрыть сходку из ленты ({ hidden: false } — вернуть)
// «Написать участникам»: организатор пишет текст, бот рассылает всем, кто записан
const eventMessages = new Map<string, number[]>(); // сходка → когда отправляли (не больше 5 в сутки)
app.post('/api/events/:id/message', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const myId = req.telegramUser!.id;
    const id = getParamId(req.params.id);
    const event = mongoose.Types.ObjectId.isValid(id) ? await Event.findById(id) : null;
    if (!event || !event.isActive) return res.status(404).json({ error: 'Сходка не найдена' });
    if (!isEventCreator(event, myId)) return res.status(403).json({ error: EVENT_MESSAGE_TEXTS.onlyCreator });
    const text = String(req.body?.text || '').trim().slice(0, 800);
    if (!text) return res.status(400).json({ error: EVENT_MESSAGE_TEXTS.empty });
    const stop = checkStopWords(text);
    if (stop) {
      await reportStopWords(stop, 'message', myId, [`Сходка «${event.title}»`, text], id);
      if (stop.level === 'ban') return res.status(403).json({ error: BANNED_ERROR });
    }
    const recipients = event.participants.filter((p) => p.telegramId !== myId);
    if (!recipients.length) return res.status(400).json({ error: EVENT_MESSAGE_TEXTS.noOne });
    const recent = (eventMessages.get(id) || []).filter((t) => Date.now() - t < 24 * 60 * 60 * 1000);
    if (recent.length >= 5) return res.status(429).json({ error: EVENT_MESSAGE_TEXTS.tooMany });
    eventMessages.set(id, [...recent, Date.now()]);

    const html = EVENT_MESSAGE_TEXTS.message(escapeHtml(event.title), escapeHtml(event.creator.name), escapeHtml(text));
    const rows: Btn[][] = [
      rsvpButtons(event),
      ...(event.creator.username ? [[{ text: EVENT_MESSAGE_TEXTS.replyBtn, url: `https://t.me/${event.creator.username.replace(/^@/, '')}` }]] : []),
      [{ text: EVENT_MESSAGE_TEXTS.openBtn, path: eventAppPath(event) }]
    ];
    let sent = 0;
    for (const p of recipients) {
      if (await sendWithButtons(p.telegramId, html, rows)) sent++;
      await new Promise((r) => setTimeout(r, 40));
    }
    res.json({ sent, total: recipients.length });
  } catch {
    res.status(500).json({ error: EVENT_MESSAGE_TEXTS.failed });
  }
});

app.post('/api/events/:id/hide', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = getParamId(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).json({ error: 'Сходка не найдена' });
    const hidden = req.body?.hidden !== false;
    await User.updateOne({ telegramId: req.telegramUser!.id }, hidden ? { $addToSet: { hiddenEvents: id } } : { $pull: { hiddenEvents: id } });
    res.json({ hidden });
  } catch {
    res.status(500).json({ error: 'Не удалось скрыть сходку' });
  }
});

// Присоединиться к событию
app.post('/api/events/:id/join', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const user = await User.findOne({ telegramId: tgUser.id });
    const eventId = getParamId(req.params.id);
    const event = await Event.findById(eventId);

    if (!event || !event.isActive) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    // «Только эмпаты» — записаться может тот, кто отметил «Эмпат» в анкете (организатор — всегда)
    if ((event.tags || []).includes('empaths') && !user?.isEmpath && event.creator.telegramId !== tgUser.id) {
      return res.status(403).json({ error: 'Эта сходка только для эмпатов. Если это про тебя, отметь «Эмпат» в анкете' });
    }

    // Сколько человек ведёт с собой и идёт ли с детьми
    const guests = Math.max(0, Math.floor(Number(req.body?.guests) || 0));
    const withKids = Boolean(req.body?.withKids);
    const mine = event.participants.find((p) => p.telegramId === tgUser.id);

    // Места: каждый участник со своими гостями. Свою прошлую запись не считаем — её заменяем
    if (event.maxParticipants && event.maxParticipants > 0) {
      const othersSeats = seatsTaken(event) - (mine ? 1 + (mine.guests || 0) : 0);
      const free = event.maxParticipants - othersSeats;
      if (1 + guests > free) {
        return res.status(400).json({
          error: free <= 0 ? 'Все места заняты' : free === 1 ? 'Осталось одно место, только для тебя' : `Осталось мест: ${free}, можно взять не больше +${free - 1}`
        });
      }
    }

    const changed = !mine || (mine.guests || 0) !== guests || Boolean(mine.withKids) !== withKids;
    if (mine) {
      mine.guests = guests;
      mine.withKids = withKids;
    } else {
      event.participants.push({
        telegramId: tgUser.id,
        name: user?.firstName || tgUser.first_name,
        username: user?.username || tgUser.username,
        avatarUrl: user?.avatarUrl || tgUser.photo_url || '',
        joinedAt: new Date(),
        guests,
        withKids
      });
    }

    await event.save();

    // Организатору — кто идёт и с кем
    if (changed && event.creator.telegramId !== tgUser.id) {
      const name = escapeHtml(user?.firstName || tgUser.first_name);
      const note = companyNote(guests, withKids);
      sendTelegramMessage(
        event.creator.telegramId,
        `${mine ? '✏️' : '🙌'} <b>${name}</b> ${mine ? 'теперь идёт' : 'идёт на твою сходку'}${note ? ` (${escapeHtml(note)})` : ''}!\n\n${eventSummaryHtml(event)}`,
        'Открыть сходку',
        eventAppPath(event)
      );
    }

    res.json({ success: true, event: formatEvent(event, tgUser.id) });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка присоединения' });
  }
});

// Покинуть событие
app.post('/api/events/:id/leave', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req.params.id);
    const event = await Event.findById(eventId);

    if (!event) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    // Из списка убираем, но в базе оставляем пометку, что человек отменил
    const leaving = event.participants.find((p) => p.telegramId === tgUser.id);
    if (leaving) {
      event.participants = event.participants.filter((p) => p.telegramId !== tgUser.id);
      event.cancellations = [
        ...(event.cancellations || []),
        { telegramId: tgUser.id, name: leaving.name, joinedAt: leaving.joinedAt, cancelledAt: new Date(), via: req.body?.via === 'bot' ? 'bot' : 'app' }
      ];
      await event.save();

      // Организатору: кто не придёт (только если сходка ещё впереди и отменил не он сам)
      if (event.isActive && event.dateTime.getTime() > Date.now() && leaving.telegramId !== event.creator.telegramId) {
        const note = companyNote(leaving.guests, leaving.withKids);
        sendTelegramMessage(
          event.creator.telegramId,
          `😕 <b>${escapeHtml(leaving.name)}${note ? ` (${note})` : ''} не придёт</b>${leaving.confirmedAt ? ', хотя раньше нажал(а) «Точно приду»' : ''}\n\n${eventSummaryHtml(event)}`,
          'Открыть сходку',
          eventAppPath(event)
        );
      }
    }

    res.json({ success: true, message: 'Вы покинули событие' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка выхода' });
  }
});

// «✅ Точно приду»: отметка у аватарки участника
app.post('/api/events/:id/confirm', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req.params.id);
    const event = mongoose.Types.ObjectId.isValid(eventId) ? await Event.findById(eventId) : null;
    if (!event || !event.isActive) return res.status(404).json({ error: 'Сходка не найдена' });
    const me = event.participants.find((p) => p.telegramId === tgUser.id);
    if (!me) return res.status(400).json({ error: 'Ты уже не записан(а) на эту сходку' });
    if (!me.confirmedAt) {
      me.confirmedAt = new Date();
      await event.save();
    }
    res.json(formatEvent(event, tgUser.id));
  } catch {
    res.status(500).json({ error: 'Не получилось отметить, попробуй ещё раз' });
  }
});

// Обновление события автором (PUT и POST)
const handleUpdateEventLogic = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req.params.id);

    if (!eventId || eventId === 'undefined' || eventId === 'null') {
      return res.status(400).json({ error: 'Не указан ID события' });
    }

    let event = null;
    if (mongoose.Types.ObjectId.isValid(eventId)) {
      event = await Event.findById(eventId);
    }
    if (!event) {
      event = await Event.findOne({ _id: eventId });
    }

    if (!event) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    if (Number(event.creator.telegramId) !== Number(tgUser.id)) {
      return res.status(403).json({ error: 'Только автор может редактировать сходку' });
    }

    const {
      title,
      description,
      category,
      customCategory,
      tags,
      locationName,
      coordinates,
      dateTime,
      maxParticipants,
      durationMinutes,
      extras,
      photos,
      isPaid,
      price
    } = req.body;

    if (isPaid !== undefined) {
      event.isPaid = Boolean(isPaid);
      event.price = event.isPaid ? cleanPrice(price) : undefined;
    }
    if (cleanPhotoIds(photos)) event.photos = cleanPhotoIds(photos);
    // Доп. поля шаблона (вид спорта, уровень…) — пересобираем метки
    if (extras !== undefined && event.templateId) {
      const tpl = await templateFields(event.templateId, extras);
      if ('error' in tpl) return res.status(400).json({ error: tpl.error });
      event.extras = tpl.extras;
      event.badges = tpl.badges;
    }
    if (durationMinutes !== undefined) event.durationMinutes = cleanDuration(durationMinutes);

    const oldTime = event.dateTime.getTime();
    const oldPlace = event.locationName;
    const textsOf = () => [event!.title, event!.description, event!.locationName, event!.customCategory, extrasText(event!.extras)];
    const oldTexts = textsOf().join('\n');

    const cleanTitle = cleanText(title, 100);
    const cleanDescription = cleanText(description, 600);
    const cleanLocation = cleanText(locationName, 150);
    if (cleanTitle) event.title = cleanTitle;
    if (cleanDescription) event.description = cleanDescription;
    if (category) {
      if (!EVENT_CATEGORIES.includes(category)) return res.status(400).json({ error: 'Неизвестный тип сходки' });
      event.category = category;
      event.customCategory = category === 'other' ? String(customCategory || '').trim().slice(0, 30) : '';
    }
    if (cleanTags(tags)) event.tags = cleanTags(tags);
    if (cleanLocation) event.locationName = cleanLocation;
    if (dateTime) {
      const when = cleanEventDate(dateTime);
      if (!when) return res.status(400).json({ error: 'Проверь дату и время сходки' });
      event.dateTime = when;
    }
    if (maxParticipants !== undefined) event.maxParticipants = seatsLimit(maxParticipants);
    const latLng = cleanLatLng(coordinates);
    if (latLng) {
      const [lat, lng] = latLng;
      event.location = {
        type: 'Point',
        coordinates: [lng, lat]
      };
    }

    const timeChanged = event.dateTime.getTime() !== oldTime;
    const placeChanged = event.locationName !== oldPlace;
    if (timeChanged) {
      // Новое время — напоминания нужно отправить заново
      event.reminderDaySentAt = undefined;
      event.reminderHourSentAt = undefined;
    }

    // Тексты изменились — проверяем на митинги и политику (без изменений не дёргаем модератора повторно)
    const newTexts = textsOf();
    const stop = newTexts.join('\n') !== oldTexts ? checkStopWords(...newTexts) : null;
    if (stop?.level === 'ban') event.isActive = false;

    await event.save();

    if (stop) {
      await reportStopWords(stop, 'eventEdit', tgUser.id, newTexts, String(event._id));
      if (stop.level === 'ban') return res.status(403).json({ error: BANNED_ERROR });
    }

    if (timeChanged || placeChanged) {
      const changes = [
        timeChanged ? `🕒 Новое время: <b>${formatWhen(event.dateTime)}</b>` : '',
        placeChanged ? `📍 Новое место: <b>${escapeHtml(event.locationName)}</b>` : ''
      ].filter(Boolean).join('\n');
      notifyParticipants(event, `✏️ <b>Сходка изменилась</b>\n\n${changes}\n\n${eventSummaryHtml(event)}`, tgUser.id);
    }

    res.json(formatEvent(event, tgUser.id));
  } catch (err: any) {
    res.status(500).json({ error: 'Ошибка обновления события' });
  }
};

app.put('/api/events/:id', telegramAuthMiddleware as any, handleUpdateEventLogic);
app.post('/api/events/:id/update', telegramAuthMiddleware as any, handleUpdateEventLogic);

// Удаление события автором
const handleDeleteEventLogic = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req.params.id);

    let event = null;
    if (mongoose.Types.ObjectId.isValid(eventId)) {
      event = await Event.findById(eventId);
    }
    if (!event) {
      event = await Event.findOne({ _id: eventId });
    }

    if (!event) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    const byModerator = Number(event.creator.telegramId) !== Number(tgUser.id);
    if (byModerator && !isAdmin(tgUser.id)) {
      return res.status(403).json({ error: 'Только создатель может удалить сходку' });
    }

    await Event.findByIdAndDelete(event._id);

    // Удалил модератор — организатору его текст, почему (а не «сходка отменена»)
    if (byModerator) {
      const reason = cleanText(req.body?.reason, 800);
      sendTelegramMessage(
        event.creator.telegramId,
        `🗑 <b>Модератор удалил твою сходку</b>\n\n«${escapeHtml(event.title)}», ${formatWhen(event.dateTime)}.${reason ? `\n\n${escapeHtml(reason)}` : ''}`
      );
    }

    // Предупреждаем участников, если сходка ещё не прошла
    if (event.dateTime.getTime() > Date.now()) {
      for (const p of event.participants) {
        if (p.telegramId === tgUser.id || p.telegramId === event.creator.telegramId) continue;
        sendTelegramMessage(
          p.telegramId,
          `😔 <b>Сходка отменена</b>\n\n«${escapeHtml(event.title)}», ${formatWhen(event.dateTime)}.\n\nЗагляни в приложение, там есть другие встречи.`,
          'Найти другую сходку',
          '?tab=events'
        );
      }
    }

    res.json({ success: true, message: 'Событие успешно удалено' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления события' });
  }
};

app.delete('/api/events/:id', telegramAuthMiddleware as any, handleDeleteEventLogic);
app.post('/api/events/:id/delete', telegramAuthMiddleware as any, handleDeleteEventLogic);

// ==========================================
// 6. РОУТ СИДИРОВАНИЯ (10 ТЕСТОВЫХ АНКЕТ В МИНСКЕ)
// ==========================================
app.get('/api/users/seed', async (_req: Request, res: Response) => {
  // Тестовые анкеты только для разработки: на рабочем сервере адрес закрыт
  if (process.env.ALLOW_SEED !== 'true') return res.sendStatus(404);
  try {
    const seedProfiles = [
      {
        telegramId: 90000001,
        firstName: 'Дарья',
        username: 'daria_minsk',
        age: 23,
        gender: 'female',
        goal: 'cafe_bar',
        areaName: 'Осмоловка',
        bio: 'Люблю архитектуру старой Осмоловки, фильтр-кофе в «Зерне» и неспешные разговоры об искусстве.',
        avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.5612, 53.9115]
      },
      {
        telegramId: 90000002,
        firstName: 'Максим',
        username: 'max_oktyabr',
        age: 27,
        gender: 'male',
        goal: 'walk',
        areaName: 'Октябрьская',
        bio: 'Гуляю по Октябрьской вдоль граффити и Свислочи. Инженер, слушаю инди-рок, ценю честное общение.',
        avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.5740, 53.8905]
      },
      {
        telegramId: 90000003,
        firstName: 'Алёна',
        username: 'alena_art',
        age: 31,
        gender: 'female',
        goal: 'expo_cinema',
        areaName: 'Немига / Центр',
        bio: 'Дизайнер интерьеров. Ищу компанию на выставки в Национальный музей или арт-хаус в кино.',
        avatarUrl: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.5520, 53.9045]
      },
      {
        telegramId: 90000004,
        firstName: 'Андрей',
        username: 'andrei_borovaya',
        age: 35,
        gender: 'male',
        goal: 'trip_outdoors',
        areaName: 'Новая Боровая',
        bio: 'Катаюсь на гравийнике, люблю вылазки к Минскому морю или Цнянке на закате. За душевные разговоры.',
        avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.6750, 53.9550]
      },
      {
        telegramId: 90000005,
        firstName: 'Полина',
        username: 'polly_uruchye',
        age: 20,
        gender: 'female',
        goal: 'walk',
        areaName: 'Уручье',
        bio: 'Студентка. Часто гуляю в Музее валунов в Уручье с термосом чая и скетчбуком. Рада спокойной компании!',
        avatarUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.6880, 53.9450]
      },
      {
        telegramId: 90000006,
        firstName: 'Дмитрий',
        username: 'dzmitry_chelyusk',
        age: 44,
        gender: 'male',
        goal: 'cafe_bar',
        areaName: 'Парк Челюскинцев',
        bio: 'Преподаватель истории. Люблю тихие аллеи ботанического сада, букинистику и хороший эспрессо.',
        avatarUrl: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.6150, 53.9240]
      },
      {
        telegramId: 90000007,
        firstName: 'Светлана',
        username: 'sveta_pobeda',
        age: 52,
        gender: 'female',
        goal: 'walk',
        areaName: 'Площадь Победы',
        bio: 'Люблю архитектуру сталинского ампира, парк Горького и пешие прогулки 10 000 шагов по Свислочи.',
        avatarUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.5750, 53.9085]
      },
      {
        telegramId: 90000008,
        firstName: 'Илья',
        username: 'ilya_zyba',
        age: 26,
        gender: 'male',
        goal: 'cafe_bar',
        areaName: 'Зыбицкая',
        bio: 'Frontend-разработчик. По вечерам не против выпить чай в Верхнем городе или поиграть в настолки.',
        avatarUrl: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.5580, 53.9055]
      },
      {
        telegramId: 90000009,
        firstName: 'Ольга',
        username: 'olga_komarovka',
        age: 38,
        gender: 'female',
        goal: 'expo_cinema',
        areaName: 'Комаровка',
        bio: 'Флорист. Обожаю субботние походы за ягодами на Комаровку, пленочную фотографию и выставки.',
        avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.5800, 53.9190]
      },
      {
        telegramId: 90000010,
        firstName: 'Евгений',
        username: 'evgeny_vostok',
        age: 29,
        gender: 'male',
        goal: 'walk',
        areaName: 'Восток / Маяк Минска',
        bio: 'Люблю вечерние прогулки у Национальной библиотеки и Дана Молл, пью раф, играю в настольные игры.',
        avatarUrl: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?auto=format&fit=crop&w=400&q=80',
        exactCoords: [27.6530, 53.9335]
      }
    ];

    for (const item of seedProfiles) {
      const [lng, lat] = item.exactCoords;
      const fuzzyCoords = obfuscateCoordinates(lng, lat);

      await User.findOneAndUpdate(
        { telegramId: item.telegramId },
        {
          $set: {
            telegramId: item.telegramId,
            username: item.username,
            firstName: item.firstName,
            age: item.age,
            gender: item.gender,
            preferredGender: 'all',
            preferredAgeRange: { min: 18, max: 99 },
            goal: item.goal,
            bio: item.bio,
            avatarUrl: item.avatarUrl,
            areaName: item.areaName,
            isTourist: false,
            hasAgreedToRules: true,
            profileCompleted: true,
            isProfileActive: true,
            blockedUsers: [],
            locationExact: { type: 'Point', coordinates: [lng, lat] },
            locationFuzzy: { type: 'Point', coordinates: fuzzyCoords },
            lastActiveAt: new Date()
          }
        },
        { upsert: true, new: true }
      );
    }

    res.json({
      success: true,
      count: seedProfiles.length,
      message: `Успешно загружено ${seedProfiles.length} тестовых анкет в Минске!`
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Ошибка сидирования' });
  }
});

// Проверка, что сервер жив (для «будильника», который не даёт серверу уснуть)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Новости проекта
setupNewsRoutes(app);
setupFundRoutes(app);

// Жалобы и модерация
setupModerationRoutes(app);

// Места по вайбу
setupPlacesRoutes(app);

// Шаблоны сходок и воронка формы
setupEventTemplateRoutes(app);
setupMeetupMetricsRoutes(app);

// Фото сходок и анкет (хранятся в Telegram)
setupPhotoRoutes(app);

// «Хочу сходить»
setupWishRoutes(app);

// Удаление аккаунта
setupAccountRoutes(app);

// Люди предлагают места
setupPlaceSuggestionRoutes(app);
setupAvatarRoutes(app);
setupProposalRoutes(app);

// Telegram-бот (/start с кнопкой открытия приложения)
setupTelegramBot(app);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 YesMinsk API запущен на порту ${PORT}`);
  registerTelegramWebhook();
  startReminderLoop();
  startDigestLoop();
  startFeedbackLoop();
  startWishLoop();
  startNudgeLoop();
  startProposalLoop();
});
