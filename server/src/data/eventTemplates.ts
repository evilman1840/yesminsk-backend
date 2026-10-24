import { IEventTemplate } from '../models/EventTemplate';

/**
 * Стартовый набор шаблонов сходок. При запуске сервер добавляет в базу те, которых там ещё нет;
 * правки автора (через /templates в боте) не затираются. Чтобы убрать шаблон — «Вкл: нет» в таблице
 */
export type TemplateSeed = { key: string; name: string } & Partial<
  Pick<IEventTemplate, 'order' | 'active' | 'emoji' | 'category' | 'title' | 'fallbackTitle' | 'description' | 'seats' | 'durationMinutes' | 'placeTypes' | 'tags' | 'fields' | 'paid'>
>;

export const DEFAULT_TEMPLATES: TemplateSeed[] = [
  {
    key: 'coffee',
    order: 10,
    emoji: '☕',
    name: 'Кофе и поболтать',
    category: 'cafe_bar',
    title: 'Кофе и поболтать',
    description: 'Без темы и без программы. Просто посидим, поговорим о чём угодно, посмеёмся. Можно уйти, когда захочется 🙂',
    seats: 4,
    durationMinutes: 90,
    placeTypes: ['Кафе', 'Кофейня']
  },
  {
    key: 'cinema',
    order: 20,
    emoji: '🎬',
    name: 'Кино',
    category: 'expo_cinema',
    title: 'Идём в кино: {фильм}',
    fallbackTitle: 'Идём в кино',
    description: 'Смотрим фильм вместе. После, если захочется, кофе рядом и обсудим. Билеты каждый покупает себе.',
    seats: 5,
    durationMinutes: 180,
    placeTypes: ['Кинотеатр'],
    paid: true,
    fields: [{ key: 'movie', token: 'фильм', label: 'Какой фильм?', type: 'text', placeholder: 'Например: «Дюна»' }]
  },
  {
    key: 'boardgames',
    order: 30,
    emoji: '🎲',
    name: 'Настолки',
    category: 'boardgames',
    title: 'Настолки и чай',
    description: 'Играем в простые настолки, правила объясним. Опыт не нужен.',
    seats: 6,
    durationMinutes: 150,
    placeTypes: ['Антикафе', 'Кафе']
  },
  {
    key: 'support',
    order: 40,
    emoji: '🫂',
    name: 'Поныть',
    category: 'support',
    title: 'Поныть за чаем',
    description: 'Можно рассказать, что накопилось. Не осуждаем и не даём советов, если не просят. Что сказано здесь, остаётся здесь.',
    seats: 4,
    durationMinutes: 90,
    placeTypes: ['Кафе', 'Кофейня'],
    tags: ['empaths']
  },
  {
    key: 'expo',
    order: 50,
    emoji: '🖼',
    name: 'Выставка',
    category: 'expo_cinema',
    title: 'Сходим на выставку',
    description: 'Идём смотреть выставку, потом можно обсудить за кофе.',
    seats: 5,
    durationMinutes: 120,
    placeTypes: ['Музей', 'Галерея']
  },
  {
    key: 'walk',
    order: 60,
    emoji: '🚶',
    name: 'Погулять и поболтать',
    category: 'walk',
    title: 'Погулять и поболтать',
    description: 'Без маршрута и экскурсий, просто гуляем и разговариваем.',
    seats: 5,
    durationMinutes: 90,
    placeTypes: ['Парк', 'Сквер']
  },
  {
    key: 'sport',
    order: 70,
    emoji: '🏓',
    name: 'Поиграем?',
    category: 'sport',
    title: '{спорт}: кто со мной?',
    fallbackTitle: 'Поиграем вместе',
    description: 'Играем в удовольствие, без счёта на результат. {уровень} Аренду корта или стола делим поровну.',
    seats: 4,
    durationMinutes: 90,
    placeTypes: ['Спорт', 'Парк'],
    paid: true,
    fields: [
      {
        key: 'sport',
        token: 'спорт',
        label: 'Во что играем?',
        type: 'select',
        required: true,
        badgeGroup: 'sport',
        allowCustom: true,
        customLabel: 'Во что именно?',
        options: [
          { value: 'tabletennis', label: 'Настольный теннис', emoji: '🏓', badge: '🏓 Настольный теннис', seatsHint: true },
          { value: 'tennis', label: 'Большой теннис', emoji: '🎾', badge: '🎾 Большой теннис', seatsHint: true },
          { value: 'squash', label: 'Сквош', emoji: '🟡', badge: '🟡 Сквош', seatsHint: true },
          { value: 'badminton', label: 'Бадминтон', emoji: '🏸', badge: '🏸 Бадминтон', seatsHint: true },
          { value: 'padel', label: 'Падел', emoji: '🎾', badge: '🎾 Падел' },
          { value: 'volleyball', label: 'Волейбол', emoji: '🏐', badge: '🏐 Волейбол' },
          { value: 'bowling', label: 'Боулинг', emoji: '🎳', badge: '🎳 Боулинг' },
          { value: 'other', label: 'Другое', emoji: '🏅', badge: '🏅' }
        ]
      },
      {
        key: 'level',
        token: 'уровень',
        label: 'Какой уровень?',
        type: 'select',
        default: 'any',
        badgeGroup: 'sport',
        options: [
          { value: 'novice', label: 'Новичок, только учусь', badge: 'для новичков', say: 'Все учимся, так что не стесняйся.' },
          { value: 'casual', label: 'Играю для себя', badge: 'играем для себя', say: 'Играем для себя, без напряга.' },
          { value: 'confident', label: 'Играю уверенно', badge: 'уверенный уровень', say: 'Если что, научим.' },
          { value: 'any', label: 'Любой', badge: 'любой уровень', say: 'Уровень любой, если что, научим.' }
        ]
      },
      {
        key: 'bring',
        label: 'Что взять?',
        type: 'text',
        placeholder: 'Например: ракетки дадут на месте, нужна спортивная обувь',
        badge: '🎒 {value}'
      }
    ]
  },
  {
    key: 'custom',
    order: 999,
    emoji: '✏️',
    name: 'Своя идея',
    placeTypes: []
  }
];
