import express, { Request, Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User, ActivityGoal, Gender, PreferredGender } from './models/User';
import { Event, EventCategory } from './models/Event';
import { obfuscateCoordinates, calculateDistanceMeters } from './utils/geoUtils';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Подключение к MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/yesminsk';
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB успешно подключена'))
  .catch((err: any) => console.warn('⚠️ Ошибка подключения MongoDB:', err?.message || err));

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
      coordinates,
      areaName,
      isTourist,
      avatarUrl,
      isProfileActive
    } = req.body;

    const updateData: any = {};
    if (firstName || name) updateData.firstName = firstName || name;
    if (avatarUrl) updateData.avatarUrl = avatarUrl;
    if (bio !== undefined) updateData.bio = bio.slice(0, 200);
    if (goal) updateData.goal = goal as ActivityGoal;
    if (age !== undefined) updateData.age = Number(age);
    if (gender) updateData.gender = gender as Gender;
    if (preferredGender) updateData.preferredGender = preferredGender as PreferredGender;
    if (preferredAgeRange) updateData.preferredAgeRange = preferredAgeRange;
    if (isTourist !== undefined) updateData.isTourist = Boolean(isTourist);
    if (areaName) {
      updateData.areaName = areaName;
      if (areaName.includes('турист')) {
        updateData.isTourist = true;
      }
    }
    if (isProfileActive !== undefined) updateData.isProfileActive = isProfileActive;

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
// 3. БЛОКИРОВКА ПОЛЬЗОВАТЕЛЯ (ЧЕРНЫЙ СПИСОК)
// ==========================================
app.post('/api/users/block', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const { blockedTelegramId } = req.body;

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
      telegramId: { $ne: tgUser.id }
    };

    if (currentUser?.blockedUsers && currentUser.blockedUsers.length > 0) {
      query.telegramId.$nin = currentUser.blockedUsers;
    }

    // Исключаем тех, кто заблокировал меня
    query.blockedUsers = { $ne: tgUser.id };

    if (goal && goal !== 'all') {
      query.goal = goal;
    }

    const users = await User.find(query).limit(50).sort({ lastActiveAt: -1 });

    const formattedUsers = users.map((u) => {
      const fuzzyCoords = u.locationFuzzy?.coordinates || [27.5615, 53.9045];
      let distanceMeters = 350;

      if (currentUser?.locationExact?.coordinates) {
        const [myLng, myLat] = currentUser.locationExact.coordinates;
        distanceMeters = calculateDistanceMeters(myLat, myLng, fuzzyCoords[1], fuzzyCoords[0]);
      }

      return {
        id: u.telegramId,
        telegramId: u.telegramId,
        firstName: u.firstName,
        username: u.username,
        avatarUrl: u.avatarUrl,
        age: u.age,
        gender: u.gender,
        goal: u.goal,
        bio: u.bio,
        areaName: u.areaName,
        isTourist: u.isTourist,
        coordinates: [fuzzyCoords[1], fuzzyCoords[0]], // [lat, lng]
        distanceMeters
      };
    });

    res.json(formattedUsers);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
});

// ==========================================
// 5. СОБЫТИЯ / СХОДКИ (EVENTS API)
// ==========================================

// Получить список событий
app.get('/api/events', telegramAuthMiddleware as any, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const { category } = req.query;

    const filter: any = {
      isActive: true,
      dateTime: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) }
    };

    if (category && category !== 'all') {
      filter.category = category as EventCategory;
    }

    const events = await Event.find(filter).sort({ dateTime: 1 }).limit(40);

    const formatted = events.map((ev) => ({
      id: ev._id.toString(),
      _id: ev._id.toString(),
      title: ev.title,
      description: ev.description,
      category: ev.category,
      locationName: ev.locationName,
      coordinates: [ev.location.coordinates[1], ev.location.coordinates[0]], // [lat, lng]
      dateTime: ev.dateTime,
      creator: ev.creator,
      participantsCount: ev.participants.length,
      maxParticipants: ev.maxParticipants || 0,
      isJoined: ev.participants.some((p) => p.telegramId === tgUser.id),
      participants: ev.participants.slice(0, 5)
    }));

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
      locationName,
      coordinates, // [lat, lng]
      dateTime,
      maxParticipants
    } = req.body;

    if (!title || !description || !locationName || !coordinates || !dateTime) {
      return res.status(400).json({ error: 'Заполните все обязательные поля события' });
    }

    const [lat, lng] = coordinates;

    const newEvent = await Event.create({
      title: title.slice(0, 100),
      description: description.slice(0, 600),
      category: category || 'walk',
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

    res.status(201).json({
      id: newEvent._id.toString(),
      _id: newEvent._id.toString(),
      title: newEvent.title,
      description: newEvent.description,
      category: newEvent.category,
      locationName: newEvent.locationName,
      coordinates: [newEvent.location.coordinates[1], newEvent.location.coordinates[0]],
      dateTime: newEvent.dateTime,
      creator: newEvent.creator,
      participantsCount: 1,
      maxParticipants: newEvent.maxParticipants || 0,
      isJoined: true,
      participants: newEvent.participants.slice(0, 5)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Ошибка создания события' });
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

    const alreadyJoined = event.participants.some((p) => p.telegramId === tgUser.id);
    if (alreadyJoined) {
      return res.json({ success: true, message: 'Уже участвуешь', event });
    }

    if (event.maxParticipants && event.maxParticipants > 0 && event.participants.length >= event.maxParticipants) {
      return res.status(400).json({ error: 'Все места заняты' });
    }

    event.participants.push({
      telegramId: tgUser.id,
      name: user?.firstName || tgUser.first_name,
      username: user?.username || tgUser.username,
      avatarUrl: user?.avatarUrl || tgUser.photo_url || '',
      joinedAt: new Date()
    });

    await event.save();
    res.json({ success: true, event });
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
      locationName,
      coordinates,
      dateTime,
      maxParticipants
    } = req.body;

    if (title) event.title = title.slice(0, 100);
    if (description) event.description = description.slice(0, 600);
    if (category) event.category = category;
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

    await event.save();

    res.json({
      id: event._id.toString(),
      _id: event._id.toString(),
      title: event.title,
      description: event.description,
      category: event.category,
      locationName: event.locationName,
      coordinates: [event.location.coordinates[1], event.location.coordinates[0]],
      dateTime: event.dateTime,
      creator: event.creator,
      participantsCount: event.participants.length,
      maxParticipants: event.maxParticipants || 0,
      isJoined: event.participants.some((p) => p.telegramId === tgUser.id),
      participants: event.participants.slice(0, 5)
    });
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 YesMinsk API запущен на порту ${PORT}`);
});
