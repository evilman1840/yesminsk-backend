import express, { Request, Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
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
import { banGuard, setupModerationRoutes } from './moderation';
import { markInviteJoined } from './invites';
import { setupPlacesRoutes } from './places';
import { seedEventTemplates, setupEventTemplateRoutes, findTemplate, buildExtras } from './eventTemplates';
import { setupMeetupMetricsRoutes } from './meetupMetrics';
import { setupPhotoRoutes, cleanPhotoIds, photoUrl } from './photos';
import { setupWishRoutes, startWishLoop, onMeetupFromWish } from './wishes';
import { Wish, WishGroup } from './models/Wish';
import { startNudgeLoop } from './nudges';
import { runPlaceImports } from './placesImport';
import { startReminderLoop, notifyParticipants, eventSummaryHtml, eventAppPath, formatWhen, seatsTaken, companyNote } from './eventNotify';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' })); // фото приходят уже сжатыми (~100 КБ), запас — для старых тяжёлых
// Забаненные не могут ничего менять
app.use('/api', banGuard);

// Подключение к MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/yesminsk';
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB успешно подключена');
    removeTestProfiles();
    runPlaceImports();
    markCompletedProfiles();
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

// Самое большое фото в анкете (data:-строка, ~450 КБ)
const MAX_AVATAR_CHARS = 600_000;

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
app.get('/api/users/me', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    let user = await User.findOne({ telegramId: tgUser.id });

    if (!user) {
      const defaultLng = 27.5615;
      const defaultLat = 53.9045;
      const fuzzyCoords = obfuscateCoordinates(defaultLng, defaultLat);

      user = await User.create({
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
        locationFuzzy: { type: 'Point', coordinates: fuzzyCoords },
        areaName: 'Немига / Центр',
        isTourist: false,
        blockedUsers: []
      });
    } else {
      user.lastActiveAt = new Date();
      await user.save();
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
    userObj.photos = (user.photos || []).map(photoUrl); // ещё фото в анкете — адресами

    res.json(userObj);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения профиля' });
  }
});

// Онбординг: согласие с правилами
app.post('/api/users/agree-rules', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const user = await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { hasAgreedToRules: true },
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
      ageConfirmed
    } = req.body;

    const updateData: any = {};
    // Ещё до 5 фото в анкете (id из /api/photos)
    if (cleanPhotoIds(photos)) updateData.photos = cleanPhotoIds(photos);
    if (firstName || name) updateData.firstName = firstName || name;
    if (avatarUrl) {
      // Защита базы от огромных фото (приложение сжимает их до ~100 КБ)
      if (String(avatarUrl).length > MAX_AVATAR_CHARS) {
        return res.status(413).json({ error: 'Фото слишком большое. Загрузи его ещё раз, приложение сожмёт автоматически' });
      }
      updateData.avatarUrl = avatarUrl;
    }
    if (bio !== undefined) updateData.bio = bio.slice(0, 200);
    if (goal) updateData.goal = goal as ActivityGoal;
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
      // ДА! МИНСК — только для взрослых
      if (Number(age) < 18) return res.status(400).json({ error: 'ДА! МИНСК только для тех, кому 18+' });
      updateData.age = Number(age);
      if (ageConfirmed) updateData.ageConfirmed = true;
      // Возраст указан сам и интересы выбраны — анкету можно показывать
      if (ageConfirmed && Array.isArray(goals) && goals.length) updateData.profileCompleted = true;
    }
    if (isEmpath !== undefined) updateData.isEmpath = Boolean(isEmpath);
    if (gender) updateData.gender = gender as Gender;
    if (preferredGender) updateData.preferredGender = preferredGender as PreferredGender;
    if (preferredAgeRange) updateData.preferredAgeRange = preferredAgeRange;
    if (isTourist !== undefined) updateData.isTourist = Boolean(isTourist);
    if (areaName) {
      updateData.areaName = areaName;
      if (/турист|проездом/i.test(areaName)) {
        updateData.isTourist = true;
      }
    }
    if (isProfileActive !== undefined) updateData.isProfileActive = isProfileActive;
    if (isGuide !== undefined) updateData.isGuide = Boolean(isGuide);
    if (guideAbout !== undefined) updateData.guideAbout = String(guideAbout).slice(0, 140);

    if (coordinates && Array.isArray(coordinates) && coordinates.length === 2) {
      const [lat, lng] = coordinates;
      updateData.locationExact = { type: 'Point', coordinates: [lng, lat] };
      updateData.locationFuzzy = {
        type: 'Point',
        coordinates: obfuscateCoordinates(lng, lat, 300, 500)
      };
    }

    const updatedUser = await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { $set: updateData },
      { new: true, upsert: true }
    );

    res.json({ success: true, user: updatedUser });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Ошибка сохранения профиля' });
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
        title: 'Поддержать ДА! МИНСК',
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
    res.status(500).json({ error: err?.message || 'Ошибка создания доната' });
  }
});

// «⚡ Есть время»: hours = 1…6 включает статус, 0 — выключает
// «🫂 Хочется поныть» на несколько часов (0 — выключить). Видят только эмпаты
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

    if (!blockedTelegramId) {
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
app.get('/api/users/nearby', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const currentUser = await User.findOne({ telegramId: tgUser.id });

    const { goal } = req.query;

    const query: any = {
      isProfileActive: true,
      hasAgreedToRules: true,
      profileCompleted: true, // пока человек не указал возраст и интересы, анкету не показываем
      telegramId: { $ne: tgUser.id }
    };

    if (currentUser?.blockedUsers && currentUser.blockedUsers.length > 0) {
      query.telegramId.$nin = currentUser.blockedUsers;
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

    const users = await User.find(query).limit(100).sort({ lastActiveAt: -1 });
    // «⚡ Свободен сейчас» — первыми в списке
    users.sort((a, b) => Number(isAvailableNow(b)) - Number(isAvailableNow(a)));
    const flags = await getReactionFlags(tgUser.id, users.map((u) => u.telegramId));

    res.json(users.map((u) => formatPublicUser(u, currentUser, flags.get(u.telegramId))));
  } catch (err) {
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
    avatarUrl: u.avatarUrl,
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
    photos: (u.photos || []).map(photoUrl)
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

const DAY = 24 * 60 * 60 * 1000;

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
    res.status(500).json({ error: err?.message || 'Ошибка сохранения реакции' });
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
    res.status(500).json({ error: err?.message || 'Ошибка загрузки симпатий' });
  }
});

// ==========================================
// 5. СОБЫТИЯ / СХОДКИ (EVENTS API)
// ==========================================

// Сходка для приложения. participantsCount — занятые места (с гостями), groupsCount — сколько записей
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
    creator: ev.creator,
    participantsCount: seatsTaken(ev),
    groupsCount: ev.participants.length,
    withKidsCount: ev.participants.filter((p) => p.withKids).length,
    maxParticipants: ev.maxParticipants || 0,
    isJoined: Boolean(mine),
    myGuests: mine?.guests || 0,
    myWithKids: Boolean(mine?.withKids),
    participants: ev.participants.slice(0, 5),
    placeId: ev.placeId ? String(ev.placeId) : undefined, // сходка в месте из «Мест» — покажем её в карточке места
    templateId: ev.templateId || undefined,
    durationMinutes: ev.durationMinutes || 0,
    extras: ev.extras || {},
    badges: ev.badges || [],
    photos: (ev.photos || []).map(photoUrl),
    isPaid: Boolean(ev.isPaid),
    price: ev.isPaid && ev.price ? ev.price : undefined,
    // «⭐ От ДА! МИНСК» — сходки автора проекта
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
    const { category } = req.query;

    const filter: any = {
      isActive: true,
      dateTime: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) }
    };

    // «Неинтересно» не показываем — кроме тех, куда человек сам записался
    const me = await User.findOne({ telegramId: tgUser.id }, { hiddenEvents: 1 }).lean();
    const hiddenIds = (me?.hiddenEvents || []).filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (hiddenIds.length) {
      filter.$or = [{ _id: { $nin: hiddenIds } }, { 'participants.telegramId': tgUser.id }];
    }

    if (category && category !== 'all') {
      filter.category = category as EventCategory;
    }

    const events = await Event.find(filter).sort({ dateTime: 1 }).limit(40);

    const formatted = events.map((ev) => formatEvent(ev, tgUser.id));

    // Официальные сходки — первыми
    formatted.sort((a, b) => Number(b.isOfficial) - Number(a.isOfficial));
    res.json(formatted);
  } catch (err) {
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

    if (!title || !description || !locationName || !coordinates || !dateTime) {
      return res.status(400).json({ error: 'Заполните все обязательные поля события' });
    }

    const tpl = await templateFields(templateId, extras);
    if ('error' in tpl) return res.status(400).json({ error: tpl.error });

    const [lat, lng] = coordinates;

    const newEvent = await Event.create({
      title: title.slice(0, 100),
      description: description.slice(0, 600),
      category: category || 'walk',
      customCategory: category === 'other' ? String(customCategory || '').trim().slice(0, 30) : '',
      tags: cleanTags(tags) || [],
      placeId: placeId && mongoose.Types.ObjectId.isValid(String(placeId)) ? String(placeId) : undefined,
      templateId: tpl.templateId,
      durationMinutes: cleanDuration(durationMinutes),
      extras: tpl.extras,
      badges: tpl.badges,
      photos: cleanPhotoIds(photos) || [],
      isPaid: Boolean(isPaid),
      price: isPaid ? cleanPrice(price) : undefined,
      locationName,
      location: {
        type: 'Point',
        coordinates: [Number(lng), Number(lat)]
      },
      dateTime: new Date(dateTime),
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
      maxParticipants: Number(maxParticipants) || 0,
      isActive: true
    });

    res.status(201).json(formatEvent(newEvent, tgUser.id));

    // Сходка в место — пишем тем, у кого оно в 🔖 сохранённых
    // Собрали по «Хочу сходить» → остальным в группе «Сходку собрали»
    if (wishGroupId) onMeetupFromWish(wishGroupId, newEvent, tgUser.id).catch((err) => console.warn('⚠️ «Хочу сходить» после сходки:', err?.message || err));
    if (newEvent.placeId) notifyPlaceSavers(newEvent).catch((err) => console.warn('⚠️ Уведомление сохранившим место:', err?.message || err));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Ошибка создания события' });
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

    event.participants = event.participants.filter((p) => p.telegramId !== tgUser.id);
    await event.save();

    res.json({ success: true, message: 'Вы покинули событие' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка выхода' });
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

    if (title) event.title = title.slice(0, 100);
    if (description) event.description = description.slice(0, 600);
    if (category) {
      event.category = category;
      event.customCategory = category === 'other' ? String(customCategory || '').trim().slice(0, 30) : '';
    }
    if (cleanTags(tags)) event.tags = cleanTags(tags);
    if (locationName) event.locationName = locationName;
    if (dateTime) event.dateTime = new Date(dateTime);
    if (maxParticipants !== undefined) event.maxParticipants = Number(maxParticipants) || 0;
    if (coordinates && Array.isArray(coordinates)) {
      const [lat, lng] = coordinates;
      event.location = {
        type: 'Point',
        coordinates: [Number(lng), Number(lat)]
      };
    }

    const timeChanged = event.dateTime.getTime() !== oldTime;
    const placeChanged = event.locationName !== oldPlace;
    if (timeChanged) {
      // Новое время — напоминания нужно отправить заново
      event.reminderDaySentAt = undefined;
      event.reminderHourSentAt = undefined;
    }

    await event.save();

    if (timeChanged || placeChanged) {
      const changes = [
        timeChanged ? `🕒 Новое время: <b>${formatWhen(event.dateTime)}</b>` : '',
        placeChanged ? `📍 Новое место: <b>${escapeHtml(event.locationName)}</b>` : ''
      ].filter(Boolean).join('\n');
      notifyParticipants(event, `✏️ <b>Сходка изменилась</b>\n\n${changes}\n\n${eventSummaryHtml(event)}`, tgUser.id);
    }

    res.json(formatEvent(event, tgUser.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Ошибка обновления события' });
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

    if (Number(event.creator.telegramId) !== Number(tgUser.id)) {
      return res.status(403).json({ error: 'Только создатель может удалить сходку' });
    }

    await Event.findByIdAndDelete(event._id);

    // Предупреждаем участников, если сходка ещё не прошла
    if (event.dateTime.getTime() > Date.now()) {
      for (const p of event.participants) {
        if (p.telegramId === tgUser.id) continue;
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
      const fuzzyCoords = obfuscateCoordinates(lng, lat, 300, 500);

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
    res.status(500).json({ error: err.message || 'Ошибка сидирования' });
  }
});

// Проверка, что сервер жив (для «будильника», который не даёт серверу уснуть)
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Новости проекта
setupNewsRoutes(app);

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
});
