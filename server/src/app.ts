import express, { Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { telegramAuthMiddleware, AuthenticatedRequest } from './middleware/telegramAuth';
import { User, ActivityGoal } from './models/User';
import { obfuscateCoordinates, calculateDistanceMeters } from './utils/geoUtils';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Подключение к MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/yesminsk';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB успешно подключена'))
  .catch((err) => console.warn('⚠️ Ошибка подключения MongoDB (для разработки):', err.message));

// 1. Получение профиля текущего пользователя («Я»)
app.get('/api/users/me', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    let user = await User.findOne({ telegramId: tgUser.id });

    if (!user) {
      // Центр Минска по умолчанию
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
        hasAgreedToRules: false,
        locationExact: { type: 'Point', coordinates: [defaultLng, defaultLat] },
        locationFuzzy: { type: 'Point', coordinates: fuzzyCoords },
        areaName: 'Минск'
      });
    } else {
      user.lastActiveAt = new Date();
      await user.save();
    }

    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 2. Онбординг: согласие с правилами (строго без дейтинга)
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

// 3. Получение пользователей для карты (с гео-фильтрацией и маскировкой координат)
app.get('/api/users/map', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { goal, lat, lng, radiusKm = 20 } = req.query;
    const filter: any = { isProfileActive: true };

    if (goal && goal !== 'all') {
      filter.goal = goal as ActivityGoal;
    }

    // Поиск ближайших пользователей через 2dsphere индекс
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

    // Исключаем точные координаты из ответа клиенту (безопасность!)
    const users = await User.find(filter)
      .select('-locationExact')
      .limit(60);

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
      areaName: u.areaName,
      coordinates: [u.locationFuzzy.coordinates[1], u.locationFuzzy.coordinates[0]], // Формат [lat, lng]
      distanceMeters: calculateDistanceMeters(
        myLat,
        myLng,
        u.locationFuzzy.coordinates[1],
        u.locationFuzzy.coordinates[0]
      )
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки пользователей карты' });
  }
});

// 4. Обновление профиля пользователя
app.put('/api/users/profile', telegramAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tgUser = req.telegramUser!;
    const { bio, goal, coordinates, areaName, isProfileActive } = req.body;

    const updateData: any = {};
    if (bio !== undefined) updateData.bio = bio.slice(0, 200);
    if (goal) updateData.goal = goal;
    if (areaName) updateData.areaName = areaName;
    if (isProfileActive !== undefined) updateData.isProfileActive = isProfileActive;

    // При обновлении гео-позиции — сохраняем точную и автоматически генерируем безопасную (fuzzy)
    if (coordinates && Array.isArray(coordinates)) {
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
      { new: true }
    ).select('-locationExact');

    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 YesMinsk API запущен на порту ${PORT}`);
});
