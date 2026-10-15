/**
 * Скрипт сидирования базы данных MongoDB реалистичными анкетами Минска
 * Запуск в терминале: node seedUsers.js
 */
const mongoose = require('mongoose');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/yesminsk';

function obfuscateCoordinates(lng, lat, minMeters = 300, maxMeters = 500) {
  const EARTH_RADIUS = 6378137;
  const radius = minMeters + Math.random() * (maxMeters - minMeters);
  const angle = Math.random() * 2 * Math.PI;

  const deltaLat = (radius * Math.cos(angle)) / EARTH_RADIUS;
  const deltaLng = (radius * Math.sin(angle)) / (EARTH_RADIUS * Math.cos((lat * Math.PI) / 180));

  const fuzzyLat = Number((lat + (deltaLat * 180) / Math.PI).toFixed(6));
  const fuzzyLng = Number((lng + (deltaLng * 180) / Math.PI).toFixed(6));

  return [fuzzyLng, fuzzyLat];
}

const seedUsersData = [
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
    exactCoords: [27.5612, 53.9115] // [lng, lat]
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
    bio: 'Дизайнер интерьеров. Ищу компанию на выставки в Национальный художественный музей или арт-хаус в кино.',
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
    bio: 'Катаюсь на гравийнике, люблю вылазки к Минскому морю или Цнянке на закате. За душевные разговоры без пафоса.',
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
    bio: 'Студентка. Часто гуляю в Музее валунов в Уручье с термосом чая и скетчбуком. Буду рада спокойной компании!',
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
    bio: 'Преподаватель истории. Люблю тихие аллеи ботанического сада, букинистические магазины и хороший эспрессо.',
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
    bio: 'Люблю архитектуру сталинского ампира, парк Горького и пешие прогулки 10 000 шагов по набережной Свислочи.',
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
    bio: 'Frontend-разработчик. По вечерам не против попробовать сидр в Верхнем городе или поиграть в настолки.',
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
    bio: 'Флорист. Обожаю субботние походы за сезонными ягодами на Комаровку, пленочную фотографию и выставки.',
    avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&w=400&q=80',
    exactCoords: [27.5800, 53.9190]
  }
];

async function seed() {
  try {
    console.log('Подключение к MongoDB...');
    await mongoose.connect(MONGODB_URI);

    const User = mongoose.model(
      'User',
      new mongoose.Schema({}, { strict: false })
    );

    for (const item of seedUsersData) {
      const [lng, lat] = item.exactCoords;
      const fuzzyCoords = obfuscateCoordinates(lng, lat, 300, 500);

      const userDoc = {
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
        locationExact: {
          type: 'Point',
          coordinates: [lng, lat]
        },
        locationFuzzy: {
          type: 'Point',
          coordinates: fuzzyCoords
        },
        lastActiveAt: new Date()
      };

      await User.findOneAndUpdate(
        { telegramId: item.telegramId },
        { $set: userDoc },
        { upsert: true, new: true }
      );
      console.log(`✓ Загружен: ${item.firstName} — ${item.areaName}`);
    }

    console.log(`\n🎉 Успешно создано ${seedUsersData.length} тестовых анкет!`);
    process.exit(0);
  } catch (err) {
    console.error('Ошибка сидирования:', err);
    process.exit(1);
  }
}

seed();
