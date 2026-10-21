import { PlaceImportItem } from '../placesImport';

/**
 * Места из таблицы «10 мест» (21.10.2026). При запуске сервер добавляет новые места
 * и обновляет данные уже существующих (по названию). Фото, отзывы и совет автора не трогает.
 * Настроения, цена и пометки — предложены при импорте, в таблице их не было.
 */
export const PLACES_IMPORT_2026_10_21: PlaceImportItem[] = [
  {
    "name": "Парк Горького",
    "category": "Парк",
    "rating": 4.8,
    "ratingCount": 3442,
    "hours": "24/7",
    "phone": "+375 17 294-42-52",
    "website": "http://parki.by/All-parks/1/kontaktygor",
    "description": "Знаковый парк: каток, летний театр, аттракционы, кафе",
    "amenities": [
      "Собаки",
      "Карты, NFC",
      "Хайкинг",
      "Доступная среда (вход, парковка)"
    ],
    "address": "ул. Фрунзе, 2",
    "mapUrl": "https://yandex.by/maps/org/tsentralnyi_dytiachyi_park_imeni_horkoho/210583171094/?ll=27.570330%2C53.903437&z=16.31",
    "coordinates": [
      53.903135,
      27.573289
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "tosku",
      "party",
      "love"
    ],
    "price": "free"
  },
  {
    "name": "Парк Челюскинцев",
    "category": "Парк",
    "rating": 4.8,
    "ratingCount": 3710,
    "hours": "24/7",
    "phone": "+375 17 280-04-49",
    "website": "http://parki.by/All-parks/2",
    "description": "Парк в Комаровском лесу, основан в 1928, около 22 000 деревьев",
    "amenities": [
      "Собаки",
      "Хайкинг",
      "Доступная среда (вход, парковка)"
    ],
    "address": "Молодёжная аллея",
    "mapUrl": "https://yandex.by/maps/org/park_kultury_i_vidpochynku_imeni_cheliuskintsiv/104132534046/?ll=27.610801%2C53.920881&z=15.56",
    "coordinates": [
      53.921146,
      27.617635
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "escape",
      "tosku",
      "solo"
    ],
    "price": "free"
  },
  {
    "name": "Парк Победы",
    "category": "Парк",
    "rating": 5,
    "ratingCount": 1872,
    "hours": "24/7",
    "phone": "+375 25 793-76-59",
    "website": "",
    "description": "Большой парк у воды: фонтаны, бег, велосипед, катера",
    "amenities": [
      "Собаки",
      "Доступная среда (вход, парковка)"
    ],
    "address": "Музейно-парковый комплекс Победы",
    "mapUrl": "https://yandex.by/maps/org/park_pobedy/35586771938/?ll=27.535959%2C53.923005&z=15.3",
    "coordinates": [
      53.922969,
      27.535127
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "love",
      "wow",
      "party"
    ],
    "price": "free"
  },
  {
    "name": "Лошицкий парк",
    "category": "Парк",
    "rating": 5,
    "ratingCount": 3557,
    "hours": "24/7",
    "phone": "+375 17 353-92-65",
    "website": "",
    "description": "Огромный парк с газонами, садами, исторической усадьбой и руинами",
    "amenities": [
      "Хайкинг",
      "Доступная среда (вход, парковка)"
    ],
    "address": "Лошицкий усадебно-парковый комплекс",
    "mapUrl": "https://yandex.by/maps/org/loshitskiy_usadebno_parkovy_kompleks/43919362848/?ll=27.581145%2C53.854918&z=15.73",
    "coordinates": [
      53.855533,
      27.579974
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "escape",
      "love",
      "solo"
    ],
    "price": "free"
  },
  {
    "name": "Большой театр оперы и балета",
    "category": "Театр",
    "rating": 5,
    "ratingCount": 3318,
    "hours": "10:00–20:00",
    "phone": "+375 17 243-10-41",
    "website": "https://bolshoibelarus.by/rus/",
    "description": "Здание 1930-х: опера, балет, классика, экскурсии",
    "amenities": [
      "Карты, NFC",
      "Доступная среда (места, вход, туалет, парковка)"
    ],
    "address": "площадь Парижской Коммуны, 1",
    "mapUrl": "https://yandex.by/maps/org/velykyi_teatr_bilorusi/1090167548/?ll=27.561607%2C53.910469&z=16.9",
    "coordinates": [
      53.910422,
      27.56157
    ],
    "rainOk": true,
    "evening": true,
    "oneDay": true,
    "moods": [
      "wow",
      "love"
    ],
    "price": "mid"
  },
  {
    "name": "Музей истории Великой Отечественной войны",
    "category": "Музей",
    "rating": 5,
    "ratingCount": 7930,
    "hours": "Вт-Вс 10:00-19:00, Пн выходной",
    "phone": "+375 17 304-11-66",
    "website": "http://www.warmuseum.by/",
    "description": "Основан в 1944, 24 экспозиционных зала",
    "amenities": [
      "Устройства для слабослышащих",
      "Доступная среда (туалет, вход, парковка)"
    ],
    "address": "просп. Победителей, 8",
    "mapUrl": "https://yandex.by/maps/org/muzey_istorii_velikoy_otechestvennoy_voyny/1082640705/?ll=27.537729%2C53.916425&z=16.9",
    "coordinates": [
      53.916413,
      27.537925
    ],
    "rainOk": true,
    "evening": false,
    "oneDay": true,
    "moods": [
      "love",
      "solo"
    ],
    "price": "cheap"
  },
  {
    "name": "Парк Михаила Павлова",
    "category": "Парк",
    "rating": 4.6,
    "ratingCount": 1180,
    "hours": "24/7",
    "phone": "",
    "website": "",
    "description": "Зелёная зона Минска с речкой, дорожками и детскими площадками для прогулок и отдыха.",
    "amenities": [
      "Собаки",
      "Хайкинг",
      "Доступный вход"
    ],
    "address": "улица Космонавтов",
    "mapUrl": "https://yandex.by/maps/org/park_imeni_mikhaila_pavlova/157611614508/?ll=27.470189%2C53.856060&z=16.52",
    "coordinates": [
      53.856141,
      27.471971
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "escape",
      "tosku"
    ],
    "price": "free"
  },
  {
    "name": "Парк 50-летия Октября",
    "category": "Парк",
    "rating": 4.5,
    "ratingCount": 321,
    "hours": "24/7",
    "phone": "+375 17 295-31-60",
    "website": "",
    "description": "Большой парк с лесными дорожками, площадками и аттракционами",
    "amenities": [
      "Собаки",
      "Хайкинг",
      "Доступный вход"
    ],
    "address": "парк культуры и отдыха имени 50-летия Великого Октября",
    "mapUrl": "https://yandex.by/maps/org/park_kultury_i_otdykha_imeni_50_letiya_velikogo_oktyabrya/1019586018/?ll=27.623657%2C53.882412&z=15.8",
    "coordinates": [
      53.880614,
      27.6228
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "party",
      "tosku"
    ],
    "price": "free"
  },
  {
    "name": "Парк Курасовщина",
    "category": "Парк",
    "rating": 4.7,
    "ratingCount": 600,
    "hours": "24/7",
    "phone": "",
    "website": "",
    "description": "Зелёный уголок Минска с водохранилищем, набережной и экотропой среди вековых дубов для спокойных прогулок.",
    "amenities": [
      "Собачья площадка",
      "Доступная среда (вход, парковка)"
    ],
    "address": "улица Корженевского",
    "mapUrl": "https://yandex.by/maps/org/park_kurasovshchina/187746658894/?ll=27.518065%2C53.848319&z=16.07",
    "coordinates": [
      53.846058,
      27.517766
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "escape",
      "solo"
    ],
    "price": "free"
  },
  {
    "name": "Парк Дружбы народов",
    "category": "Парк",
    "rating": 4.4,
    "ratingCount": 1044,
    "hours": "24/7",
    "phone": "",
    "website": "",
    "description": "Просторная зелёная зона Минска у площади Бангалор, созданная на месте бывшей опытной болотной станции.",
    "amenities": [
      "Собаки",
      "Доступный вход"
    ],
    "address": "парк Дружбы Народов",
    "mapUrl": "https://yandex.by/maps/org/park_druzhby_narodiv/80834092067/?ll=27.570962%2C53.932920&z=15.49",
    "coordinates": [
      53.93311,
      27.570056
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "escape",
      "tosku"
    ],
    "price": "free"
  },
  {
    "name": "Севастопольский парк",
    "category": "Парк",
    "rating": 4.5,
    "ratingCount": 716,
    "hours": "24/7",
    "phone": "",
    "website": "",
    "description": "Тенистый парк для прогулок и пикников, теннисные корты, площадка",
    "amenities": [
      "Собаки",
      "Парковка для маломобильных"
    ],
    "address": "Севастопольский парк",
    "mapUrl": "https://yandex.by/maps/org/sevastopolskyi_park/222314476096/?ll=27.613472%2C53.940249&z=14.78",
    "coordinates": [
      53.940464,
      27.622736
    ],
    "rainOk": false,
    "evening": false,
    "oneDay": false,
    "moods": [
      "escape",
      "tosku"
    ],
    "price": "free"
  }
];
