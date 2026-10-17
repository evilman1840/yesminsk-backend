import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { User } from './models/User';
import { Event } from './models/Event';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { obfuscateCoordinates } from './utils/geoUtils';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/yesminsk';

// Хелпер для безопасного извлечения строкового ID из req.params (защита от TS2345)
const getParamId = (req: Request | AuthenticatedRequest): string => {
  const raw = req.params.id;
  if (Array.isArray(raw)) {
    return String(raw[0] || '').trim();
  }
  return String(raw || '').trim();
};

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Telegram-Init-Data']
}));

app.use(express.json({ limit: '10mb' }));

// Базовый роут проверки здоровья
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'yesminsk-api', timestamp: new Date() });
});
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'yesminsk-api', timestamp: new Date() });
});

// ==========================================
// 1. РОУТЫ ПОЛЬЗОВАТЕЛЕЙ (USERS)
// ==========================================

// Сохранение / обновление профиля
const handleProfileUpdate = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const {
      name,
      firstName,
      age,
      bio,
      gender,
      preferredGender,
      preferredAgeRange,
      goal,
      goals,
      avatarUrl,
      areaName,
      isTourist,
      coordinates
    } = req.body;

    const coords = Array.isArray(coordinates) && coordinates.length === 2
      ? coordinates
      : [53.9045, 27.5615];

    const safeCoords = obfuscateCoordinates(coords[0], coords[1]);

    const updatedUser = await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      {
        telegramId: tgUser.id,
        firstName: name || firstName || tgUser.first_name,
        lastName: tgUser.last_name || '',
        username: tgUser.username || '',
        age: Number(age) || 25,
        bio: (bio || '').slice(0, 200),
        gender: gender || 'not_specified',
        preferredGender: preferredGender || 'all',
        preferredAgeRange: preferredAgeRange || { min: 18, max: 45 },
        goal: goal || 'walk',
        goals: goals || [goal || 'walk'],
        avatarUrl: avatarUrl || tgUser.photo_url || '',
        areaName: areaName || 'Центр / Немига',
        isTourist: Boolean(isTourist),
        locationExact: {
          type: 'Point',
          coordinates: [coords[1], coords[0]]
        },
        locationObfuscated: {
          type: 'Point',
          coordinates: [safeCoords[1], safeCoords[0]]
        },
        lastActive: new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      user: {
        id: updatedUser.telegramId,
        telegramId: updatedUser.telegramId,
        firstName: updatedUser.firstName,
        username: updatedUser.username,
        age: updatedUser.age,
        bio: updatedUser.bio,
        gender: updatedUser.gender,
        preferredGender: updatedUser.preferredGender,
        preferredAgeRange: updatedUser.preferredAgeRange,
        goal: updatedUser.goal,
        goals: updatedUser.goals,
        avatarUrl: updatedUser.avatarUrl,
        areaName: updatedUser.areaName,
        isTourist: updatedUser.isTourist,
        coordinates: [
          updatedUser.locationObfuscated.coordinates[1],
          updatedUser.locationObfuscated.coordinates[0]
        ]
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Ошибка сохранения профиля' });
  }
};

app.post('/api/users/profile', telegramAuthMiddleware, handleProfileUpdate);
app.post('/users/profile', telegramAuthMiddleware, handleProfileUpdate);

// Получение профиля текущего пользователя
app.get('/api/users/me', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const user = await User.findOne({ telegramId: tgUser.id });
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json({
      id: user.telegramId,
      telegramId: user.telegramId,
      firstName: user.firstName,
      username: user.username,
      age: user.age,
      bio: user.bio,
      gender: user.gender,
      preferredGender: user.preferredGender,
      preferredAgeRange: user.preferredAgeRange,
      goal: user.goal,
      goals: user.goals,
      avatarUrl: user.avatarUrl,
      areaName: user.areaName,
      isTourist: user.isTourist,
      coordinates: [
        user.locationObfuscated.coordinates[1],
        user.locationObfuscated.coordinates[0]
      ]
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения профиля' });
  }
});

// Получение пользователей поблизости с учетом фильтров и блокировок
const handleNearbyUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const currentUser = await User.findOne({ telegramId: tgUser.id });

    const blockedIds: number[] = currentUser?.blockedUsers || [];
    const usersWhoBlockedMe = await User.find({ blockedUsers: tgUser.id }).distinct('telegramId');
    const allExcludedIds = Array.from(new Set([...blockedIds, ...usersWhoBlockedMe, tgUser.id]));

    const queryFilter: any = {
      telegramId: { $nin: allExcludedIds }
    };

    if (currentUser?.preferredGender && currentUser.preferredGender !== 'all') {
      queryFilter.gender = currentUser.preferredGender;
    }

    if (currentUser?.preferredAgeRange) {
      queryFilter.age = {
        $gte: currentUser.preferredAgeRange.min || 18,
        $lte: currentUser.preferredAgeRange.max || 99
      };
    }

    const users = await User.find(queryFilter).limit(60).sort({ lastActive: -1 });

    const formatted = users.map((u) => ({
      id: u.telegramId,
      telegramId: u.telegramId,
      firstName: u.firstName,
      username: u.username,
      age: u.age,
      gender: u.gender,
      goal: u.goal,
      goals: u.goals,
      avatarUrl: u.avatarUrl,
      bio: u.bio,
      areaName: u.areaName,
      isTourist: u.isTourist,
      distanceMeters: Math.floor(Math.random() * 200) + 300,
      coordinates: [
        u.locationObfuscated.coordinates[1],
        u.locationObfuscated.coordinates[0]
      ]
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
};

app.get('/api/users/nearby', telegramAuthMiddleware, handleNearbyUsers);
app.get('/users/nearby', telegramAuthMiddleware, handleNearbyUsers);

// Блокировка пользователя
app.post('/api/users/block', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'Не указан ID пользователя' });
    }

    await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { $addToSet: { blockedUsers: Number(targetUserId) } }
    );

    res.json({ success: true, message: 'Пользователь заблокирован' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка блокировки' });
  }
});

// ==========================================
// 2. РОУТЫ СОБЫТИЙ / СХОДОК (EVENTS)
// ==========================================

// Список активных событий
const handleGetEvents = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const events = await Event.find({ isActive: true }).sort({ dateTime: 1 }).limit(50);

    const formatted = events.map((ev) => ({
      id: ev._id.toString(),
      _id: ev._id.toString(),
      title: ev.title,
      description: ev.description,
      category: ev.category,
      locationName: ev.locationName,
      coordinates: [ev.location.coordinates[1], ev.location.coordinates[0]],
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
};

app.get('/api/events', telegramAuthMiddleware, handleGetEvents);
app.get('/events', telegramAuthMiddleware, handleGetEvents);

// Создание события
const handleCreateEvent = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const user = await User.findOne({ telegramId: tgUser.id });

    const {
      title,
      description,
      category,
      locationName,
      coordinates,
      dateTime,
      maxParticipants
    } = req.body;

    if (!title || !description || !locationName || !coordinates || !dateTime) {
      return res.status(400).json({ error: 'Заполните обязательные поля' });
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
      participants: newEvent.participants
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Ошибка создания сходки' });
  }
};

app.post('/api/events', telegramAuthMiddleware, handleCreateEvent);
app.post('/events', telegramAuthMiddleware, handleCreateEvent);

// Обновление события (PUT / POST)
const handleUpdateEvent = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req);

    if (!eventId || !mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ error: 'Некорректный ID события' });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    if (Number(event.creator.telegramId) !== Number(tgUser.id)) {
      return res.status(403).json({ error: 'Только создатель может редактировать событие' });
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

app.put('/api/events/:id', telegramAuthMiddleware, handleUpdateEvent);
app.post('/api/events/:id', telegramAuthMiddleware, handleUpdateEvent);
app.put('/events/:id', telegramAuthMiddleware, handleUpdateEvent);

// Удаление события
const handleDeleteEvent = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req);

    if (!eventId || !mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ error: 'Некорректный ID события' });
    }

    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    if (Number(event.creator.telegramId) !== Number(tgUser.id)) {
      return res.status(403).json({ error: 'Только создатель может удалить событие' });
    }

    await Event.findByIdAndDelete(event._id);
    res.json({ success: true, message: 'Событие удалено' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления события' });
  }
};

app.delete('/api/events/:id', telegramAuthMiddleware, handleDeleteEvent);
app.delete('/events/:id', telegramAuthMiddleware, handleDeleteEvent);

// Присоединиться к событию
app.post('/api/events/:id/join', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req);

    if (!eventId || !mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    const event = await Event.findById(eventId);
    if (!event || !event.isActive) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    const alreadyJoined = event.participants.some((p) => p.telegramId === tgUser.id);
    if (!alreadyJoined) {
      const user = await User.findOne({ telegramId: tgUser.id });
      event.participants.push({
        telegramId: tgUser.id,
        name: user?.firstName || tgUser.first_name,
        username: user?.username || tgUser.username,
        avatarUrl: user?.avatarUrl || tgUser.photo_url || '',
        joinedAt: new Date()
      });
      await event.save();
    }

    res.json({ success: true, message: 'Успешно присоединились' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка записи на сходку' });
  }
});

// Покинуть событие
app.post('/api/events/:id/leave', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const eventId = getParamId(req);

    if (!eventId || !mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ error: 'Некорректный ID' });
    }

    const event = await Event.findById(eventId);
    if (event) {
      event.participants = event.participants.filter((p) => p.telegramId !== tgUser.id);
      await event.save();
    }

    res.json({ success: true, message: 'Вы вышли из сходки' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка выхода' });
  }
});

// ==========================================
// 3. СИДЕР ТЕСТОВЫХ ПОЛЬЗОВАТЕЛЕЙ (SEED ROUTE)
// ==========================================
const handleSeed = async (_req: Request, res: Response) => {
  try {
    const seedProfiles = [
      {
        telegramId: 900000001,
        firstName: 'Полина',
        age: 23,
        gender: 'female',
        preferredGender: 'all',
        preferredAgeRange: { min: 20, max: 35 },
        goal: 'walk',
        goals: ['walk', 'culture'],
        avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200',
        bio: 'Люблю неспешные прогулки по Осмоловке с фильтр-кофе ☕️. Ищу компанию на выставки.',
        areaName: 'Центр / Немига',
        coords: [53.9045, 27.5520]
      },
      {
        telegramId: 900000002,
        firstName: 'Максим',
        age: 28,
        gender: 'male',
        preferredGender: 'all',
        preferredAgeRange: { min: 22, max: 40 },
        goal: 'bar',
        goals: ['bar', 'walk'],
        avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200',
        bio: 'Заглянуть на Октябрьскую в пятницу вечером, поболтать про дизайн и урбанистику.',
        areaName: 'Октябрьская / Первомайская',
        coords: [53.8905, 27.5740]
      },
      {
        telegramId: 900000003,
        firstName: 'Алина',
        age: 26,
        gender: 'female',
        preferredGender: 'female',
        preferredAgeRange: { min: 21, max: 32 },
        goal: 'culture',
        goals: ['culture', 'walk'],
        avatarUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200',
        bio: 'Ищу компанию для походов в арт-пространства и кинотеатр «Центральный».',
        areaName: 'Площадь Победы',
        coords: [53.9085, 27.5750]
      },
      {
        telegramId: 900000004,
        firstName: 'Артем',
        age: 31,
        gender: 'male',
        preferredGender: 'all',
        preferredAgeRange: { min: 24, max: 45 },
        goal: 'trip',
        goals: ['trip', 'walk'],
        avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200',
        bio: 'Выходные на Минском море или покатушки на велосипедах вдоль Свислочи 🚴.',
        areaName: 'Парк Челюскинцев',
        coords: [53.9240, 27.6150]
      },
      {
        telegramId: 900000005,
        firstName: 'София',
        age: 22,
        gender: 'female',
        preferredGender: 'all',
        preferredAgeRange: { min: 20, max: 30 },
        goal: 'walk',
        goals: ['walk', 'bar'],
        avatarUrl: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=200',
        bio: 'Учусь на архитектора. Обожаю бродить по Троицкому предместью и фоткать на плёнку.',
        areaName: 'Троицкое / Верхний город',
        coords: [53.9080, 27.5560]
      },
      {
        telegramId: 900000006,
        firstName: 'Дмитрий',
        age: 35,
        gender: 'male',
        preferredGender: 'all',
        preferredAgeRange: { min: 25, max: 50 },
        goal: 'boardgames',
        goals: ['boardgames', 'bar'],
        avatarUrl: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=200',
        bio: 'Собираю настолки (Catan, Ticket to Ride, Dune). Всегда рад новым игрокам в клубах.',
        areaName: 'Комаровка / В. Хоружей',
        coords: [53.9190, 27.5800]
      },
      {
        telegramId: 900000007,
        firstName: 'Елена',
        age: 42,
        gender: 'female',
        preferredGender: 'all',
        preferredAgeRange: { min: 30, max: 55 },
        goal: 'walk',
        goals: ['walk', 'culture'],
        avatarUrl: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=200',
        bio: 'Прогулки по Ботаническому саду, разговоры о книгах и искусстве.',
        areaName: 'Парк Челюскинцев',
        coords: [53.9210, 27.6100]
      },
      {
        telegramId: 900000008,
        firstName: 'Илья',
        age: 24,
        gender: 'male',
        preferredGender: 'all',
        preferredAgeRange: { min: 20, max: 30 },
        goal: 'bar',
        goals: ['bar', 'walk'],
        avatarUrl: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=200',
        bio: 'Знаю где в Минске лучший спешелти-кофе. С удовольствием составлю компанию.',
        areaName: 'Карла Маркса / Ленина',
        coords: [53.8975, 27.5570]
      },
      {
        telegramId: 900000009,
        firstName: 'Ксения',
        age: 29,
        gender: 'female',
        preferredGender: 'all',
        preferredAgeRange: { min: 22, max: 40 },
        goal: 'sport',
        goals: ['sport', 'walk'],
        avatarUrl: 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=200',
        bio: 'Пробежки в Парке Победы по утрам или бадминтон. Присоединяйтесь!',
        areaName: 'Парк Победы / Комсомольское',
        coords: [53.9240, 27.5450]
      },
      {
        telegramId: 900000010,
        firstName: 'Никита',
        age: 27,
        gender: 'male',
        preferredGender: 'all',
        preferredAgeRange: { min: 22, max: 38 },
        goal: 'walk',
        goals: ['walk', 'bar'],
        avatarUrl: 'https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=200',
        bio: 'Живу в Новой Боровой. Гуляю с собакой, буду рад компании на кофе.',
        areaName: 'Новая Боровая',
        coords: [53.9550, 27.6750]
      }
    ];

    for (const p of seedProfiles) {
      const safe = obfuscateCoordinates(p.coords[0], p.coords[1]);
      await User.findOneAndUpdate(
        { telegramId: p.telegramId },
        {
          telegramId: p.telegramId,
          firstName: p.firstName,
          age: p.age,
          gender: p.gender,
          preferredGender: p.preferredGender,
          preferredAgeRange: p.preferredAgeRange,
          goal: p.goal,
          goals: p.goals,
          avatarUrl: p.avatarUrl,
          bio: p.bio,
          areaName: p.areaName,
          isTourist: false,
          locationExact: {
            type: 'Point',
            coordinates: [p.coords[1], p.coords[0]]
          },
          locationObfuscated: {
            type: 'Point',
            coordinates: [safe[1], safe[0]]
          },
          lastActive: new Date()
        },
        { upsert: true, new: true }
      );
    }

    res.json({
      success: true,
      count: seedProfiles.length,
      message: `Успешно загружено ${seedProfiles.length} анкет в Минске!`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Ошибка сидирования' });
  }
};

app.get('/api/users/seed', handleSeed);
app.get('/users/seed', handleSeed);

// Запуск сервера
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('MongoDB подключена успешно');
    app.listen(PORT, () => {
      console.log(`Сервер YesMinsk запущен на порту ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Ошибка подключения MongoDB:', err);
  });

export default app;
