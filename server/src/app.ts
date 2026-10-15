import express, { Response } from 'express';
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
  .catch((err) => console.warn('⚠️ Ошибка подключения MongoDB:', err.message));

// ==========================================
// 1. ПРОФИЛЬ ТЕКУЩЕГО ПОЛЬЗОВАТЕЛЯ («Я»)
// ==========================================
app.get('/api/users/me', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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
        areaName: 'Минск',
        isTourist: false,
        blockedUsers: []
      });
    } else {
      user.lastActiveAt = new Date();
      await user.save();
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения профиля' });
  }
});

// Онбординг: согласие с правилами
app.post('/api/users/agree-rules', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const user = await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { hasAgreedToRules: true },
      { new: true }
    );
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления' });
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

    // Обновление координат (точное и безопасное смещение)
    if (coordinates && Array.isArray(coordinates)) {
      const [lat, lng] = coordinates;
      updateData.locationExact = { type: 'Point', coordinates: [lng, lat] };
      updateData.locationFuzzy = {
        type: 'Point',
        coordinates: obfuscateCoordinates(lng, lat, 300, 500)
      };
    } else if (updateData.isTourist && !updateData.locationExact) {
      // Для туристов по умолчанию центрируем на Минске (Немига)
      const defaultLng = 27.5615;
      const defaultLat = 53.9045;
      updateData.locationExact = { type: 'Point', coordinates: [defaultLng, defaultLat] };
      updateData.locationFuzzy = {
        type: 'Point',
        coordinates: obfuscateCoordinates(defaultLng, defaultLat, 300, 500)
      };
    }

    const updatedUser = await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { $set: updateData },
      { new: true, upsert: true }
    ).select('-locationExact');

    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения профиля' });
  }
};

app.post('/api/users/profile', telegramAuthMiddleware, handleUpdateProfile);
app.put('/api/users/profile', telegramAuthMiddleware, handleUpdateProfile);

// ==========================================
// 3. БЛОКИРОВКА / ЧЕРНЫЙ СПИСОК
// ==========================================
app.post('/api/users/block', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const { targetTelegramId } = req.body;

    if (!targetTelegramId || targetTelegramId === tgUser.id) {
      return res.status(400).json({ error: 'Некорректный targetTelegramId' });
    }

    await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { $addToSet: { blockedUsers: Number(targetTelegramId) } }
    );

    res.json({ success: true, message: 'Пользователь заблокирован' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка блокировки' });
  }
});

app.post('/api/users/unblock', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const { targetTelegramId } = req.body;

    await User.findOneAndUpdate(
      { telegramId: tgUser.id },
      { $pull: { blockedUsers: Number(targetTelegramId) } }
    );

    res.json({ success: true, message: 'Пользователь разблокирован' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка разблокировки' });
  }
});

// ==========================================
// 4. ВЫДАЧА ЛЮДЕЙ РЯДОМ С ФИЛЬТРАМИ И ЧЕРНЫМ СПИСКОМ
// ==========================================
const handleGetUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const currentUser = await User.findOne({ telegramId: tgUser.id });

    const { goal, lat, lng, radiusKm = 25 } = req.query;

    const filter: any = {
      isProfileActive: true,
      telegramId: { $ne: tgUser.id } // Исключаем себя
    };

    // 1. Черный список в обе стороны
    if (currentUser?.blockedUsers && currentUser.blockedUsers.length > 0) {
      filter.telegramId.$nin = currentUser.blockedUsers;
    }
    filter.blockedUsers = { $ne: tgUser.id };

    // 2. Фильтрация по цели
    if (goal && goal !== 'all') {
      filter.goal = goal as ActivityGoal;
    }

    // 3. Фильтрация по предпочтению пола (двусторонняя)
    if (currentUser && currentUser.preferredGender !== 'all') {
      filter.gender = currentUser.preferredGender;
    }
    if (currentUser?.gender && currentUser.gender !== 'not_specified') {
      filter.preferredGender = { $in: ['all', currentUser.gender] };
    }

    // 4. Фильтрация по возрасту (двусторонняя)
    if (currentUser?.preferredAgeRange) {
      filter.age = {
        $gte: currentUser.preferredAgeRange.min,
        $lte: currentUser.preferredAgeRange.max
      };
    }
    if (currentUser?.age) {
      filter['preferredAgeRange.min'] = { $lte: currentUser.age };
      filter['preferredAgeRange.max'] = { $gte: currentUser.age };
    }

    // 5. Гео-поиск через индекс 2dsphere
    if (lat && lng) {
      filter.locationFuzzy = {
        $nearSphere: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(lng as string), parseFloat(lat as string)]
          },
          $maxDistance: Number(radiusKm) * 1000
        }
      };
    }

    const users = await User.find(filter).select('-locationExact').limit(60);

    const myLat = lat ? parseFloat(lat as string) : 53.9045;
    const myLng = lng ? parseFloat(lng as string) : 27.5615;

    const formatted = users.map((u) => ({
      id: u._id,
      telegramId: u.telegramId,
      firstName: u.firstName,
      username: u.username,
      avatarUrl: u.avatarUrl,
      bio: u.bio,
      goal: u.goal,
      age: u.age,
      gender: u.gender,
      isTourist: u.isTourist,
      areaName: u.areaName,
      coordinates: [u.locationFuzzy.coordinates[1], u.locationFuzzy.coordinates[0]], // [lat, lng]
      distanceMeters: calculateDistanceMeters(
        myLat,
        myLng,
        u.locationFuzzy.coordinates[1],
        u.locationFuzzy.coordinates[0]
      )
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки пользователей' });
  }
};

app.get('/api/users/nearby', telegramAuthMiddleware, handleGetUsers);
app.get('/api/users/map', telegramAuthMiddleware, handleGetUsers);

// ==========================================
// 5. СОБЫТИЯ / СХОДКИ (EVENTS API)
// ==========================================

// Список актуальных событий
app.get('/api/events', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const { category, lat, lng, radiusKm = 30 } = req.query;

    const filter: any = {
      isActive: true,
      dateTime: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) } // события не старше 4 часов
    };

    if (category && category !== 'all') {
      filter.category = category as EventCategory;
    }

    if (lat && lng) {
      filter.location = {
        $nearSphere: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(lng as string), parseFloat(lat as string)]
          },
          $maxDistance: Number(radiusKm) * 1000
        }
      };
    }

    const events = await Event.find(filter).sort({ dateTime: 1 }).limit(40);

    const formatted = events.map((ev) => ({
      id: ev._id,
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

// Создание нового события
app.post('/api/events', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
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

    res.status(201).json(newEvent);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Ошибка создания события' });
  }
});

// Присоединиться к событию
app.post('/api/events/:id/join', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const user = await User.findOne({ telegramId: tgUser.id });
    const event = await Event.findById(req.params.id);

    if (!event || !event.isActive) {
      return res.status(404).json({ error: 'Событие не найдено или завершено' });
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
    res.status(500).json({ error: 'Ошибка присоединения к событию' });
  }
});

// Покинуть событие
app.post('/api/events/:id/leave', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    event.participants = event.participants.filter((p) => p.telegramId !== tgUser.id);
    await event.save();

    res.json({ success: true, message: 'Вы покинули событие' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка выхода из события' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 YesMinsk API запущен на порту ${PORT}`);
});
