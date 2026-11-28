/** Voluntary friendship questionnaire. Keep this catalogue in sync with the server. */
export const QUESTIONNAIRE_VERSION = 1;
export interface ChoiceQuestion { key: string; title: string; options: string[]; max: number; exclusive?: string; }
export const CORE_QUESTIONS: ChoiceQuestion[] = [
  { key: 'intentions', title: 'Кого и для чего ты хочешь найти в ГУЛЯЙ?', max: 4, options: ['Друзей для регулярного общения', 'Компанию для прогулок и сходок', 'Людей с общими увлечениями', 'Пока хочу знакомиться и смотреть, что получится'] },
  { key: 'activities', title: 'На что тебя можно позвать?', max: 5, options: ['Прогулки по городу', 'Кофе и разговоры', 'Кафе и рестораны', 'Настольные игры', 'Кино', 'Выставки и музеи', 'Театр и выступления', 'Концерты', 'Бары', 'Вечеринки и танцы', 'Спорт и тренировки', 'Горнолыжка', 'Велосипед', 'Походы и прогулки на природе', 'Поездки за город', 'Прогулки с собаками', 'Творческие занятия и мастер-классы', 'Новые и необычные занятия'] },
  { key: 'companySizes', title: 'В какой компании тебе комфортнее знакомиться?', max: 4, exclusive: 'Размер компании не важен', options: ['Вдвоём', 'Втроём-вчетвером', 'Компанией 5–8 человек', 'Большой компанией, от 9 человек', 'Размер компании не важен'] },
  { key: 'restStyles', title: 'Какой отдых тебе обычно ближе?', max: 2, exclusive: 'Каждый раз по-разному', options: ['Спокойно посидеть и поговорить', 'Прогуляться без спешки', 'Куда-нибудь сходить и попробовать новое', 'Активно подвигаться', 'Пошуметь и повеселиться', 'Каждый раз по-разному'] },
  { key: 'topics', title: 'О чём тебе нравится разговаривать?', max: 3, options: ['Смешные истории и повседневная жизнь', 'Кино, сериалы, музыка и книги', 'Путешествия и новые места', 'Увлечения и творчество', 'Работа, бизнес и проекты', 'Технологии и наука', 'Отношения, чувства и личный опыт', 'Жизнь, ценности и философские вопросы', 'Понемногу обо всём'] },
  { key: 'availability', title: 'Когда тебя обычно можно позвать?', max: 7, options: ['В будни утром', 'В будни днём', 'В будни вечером', 'В выходные днём', 'В выходные вечером', 'Поздним вечером и ночью', 'У меня плавающий график'] },
  { key: 'meetingAreas', title: 'Где тебе удобно встречаться?', max: 51, options: [] },
  { key: 'budget', title: 'Какой бюджет встречи тебе обычно комфортен?', max: 1, options: ['Предпочитаю бесплатные встречи', 'До 15 BYN', 'Больше 15, но не больше 35 BYN', 'Больше 35 BYN', 'Зависит от события, обсужу заранее'] }
];
export const EXTRA_QUESTIONS: ChoiceQuestion[] = [
  { key: 'wants', title: 'Что тебе сейчас хочется?', max: 5, options: ['Найти постоянную компанию', 'Чаще выбираться из дома', 'Попробовать новое увлечение', 'Найти компанию для спорта', 'Открыть интересные места Минска', 'Выбраться за город', 'Найти компанию для путешествий', 'Научиться чему-то', 'Реализовать идею вместе с кем-то', 'Получить помощь с бытовой задачей', 'Просто поговорить и побыть в компании'] },
  { key: 'offers', title: 'Что ты можешь предложить другим?', max: 5, options: ['Составить компанию', 'Показать любимые места Минска', 'Придумать маршрут прогулки', 'Организовать сходку', 'Объяснить правила настольной игры', 'Позаниматься спортом вместе', 'Поделиться знаниями или навыком', 'Пофотографировать на прогулке', 'Помочь с техникой', 'Помочь с бытовой задачей', 'Помочь организовать поездку', 'Выслушать и поддержать разговором'] }
];
const scale = ['1','2','3','4','5','6','7','8','9','10','Не хочу оценивать'];
export const PERSONAL_QUESTIONS: ChoiceQuestion[] = [
  { key: 'appearanceSelf', title: 'Насколько привлекательным человеком ты себя считаешь?', max: 1, options: scale },
  { key: 'appearanceFriendship', title: 'Насколько внешность влияет на твоё желание продолжить дружеское знакомство?', max: 1, options: ['Почти не влияет', 'Немного влияет', 'Сильно влияет', 'Это один из главных факторов'] },
  { key: 'humour', title: 'Какой юмор тебе ближе?', max: 2, options: ['Добрый и лёгкий', 'Сарказм', 'Чёрный юмор', 'Провокационный и неполиткорректный', 'Зависит от человека и ситуации'] },
  { key: 'differentViews', title: 'Как тебе общение с людьми, чьи взгляды сильно отличаются от твоих?', max: 1, options: ['Люблю обсуждать разные взгляды', 'Нормально, если без споров', 'Предпочитаю обходить спорные темы', 'Хочу общаться преимущественно с близкими по взглядам людьми'] },
  { key: 'disagreement', title: 'Если друг делает что-то, что тебе не нравится, ты скорее…', max: 1, options: ['Скажу прямо', 'Подберу мягкие слова', 'Промолчу, пока это не станет серьёзной проблемой', 'Начну отдаляться', 'Зависит от ситуации'] },
  { key: 'intelligenceSelf', title: 'Насколько умным человеком ты себя считаешь?', max: 1, options: scale },
  { key: 'helpFriend', title: 'Если ради помощи другу придётся отменить свои планы…', max: 1, options: ['Обычно соглашусь помочь', 'Зависит от ситуации', 'Отменю планы только ради серьёзной проблемы', 'Обычно постараюсь помочь в другое время'] },
  { key: 'differentBudget', title: 'Если друзья могут позволить себе гораздо больше расходов, чем ты…', max: 1, options: ['Мне комфортно', 'Нормально, если учитывают мой бюджет', 'Чувствую напряжение', 'Предпочитаю компанию с похожим бюджетом', 'Нет такого опыта'] },
  { key: 'friendshipNotMutual', title: 'Если желание дружить оказалось невзаимным…', max: 1, options: ['Могу продолжить общение без ожиданий', 'Мне нужна пауза', 'Предпочту закончить знакомство', 'Зависит от ситуации'] },
  { key: 'alcohol', title: 'Как тебе компания, в которой люди употребляют алкоголь?', max: 1, options: ['Хочу встречи без алкоголя', 'Нормально, если другие пьют умеренно', 'Люблю выпить вместе', 'Зависит от встречи'] }
];
export interface PersonalAnswer { values: string[]; visible: boolean; }
export interface Questionnaire {
  version: number;
  intentions?: string[]; activities?: string[]; favouriteActivity?: string;
  companySizes?: string[]; restStyles?: string[]; topics?: string[]; availability?: string[];
  meetingAreas?: string[]; budget?: string[]; wants?: string[]; offers?: string[];
  wantDetails?: string; offerDetails?: string;
  personal?: Record<string, PersonalAnswer>;
}
export const questionnaireCount = (q?: Questionnaire) => CORE_QUESTIONS.filter(f => { const answer = q?.[f.key as keyof Questionnaire]; return Array.isArray(answer) && answer.length > 0; }).length;
export const questionnaireComplete = (q?: Questionnaire) => questionnaireCount(q) === CORE_QUESTIONS.length;

// Detailed answers continue to work with the existing broad activity filters and ranking.
export function legacyActivities(activities: string[]) {
  type Goal = 'walk' | 'cafe_bar' | 'expo_cinema' | 'trip_outdoors' | 'boardgames' | 'sport' | 'other';
  const map: Record<string, Goal> = {
    'Прогулки по городу': 'walk', 'Прогулки с собаками': 'walk',
    'Кофе и разговоры': 'cafe_bar', 'Кафе и рестораны': 'cafe_bar', 'Бары': 'cafe_bar',
    'Настольные игры': 'boardgames', 'Кино': 'expo_cinema', 'Выставки и музеи': 'expo_cinema', 'Театр и выступления': 'expo_cinema',
    'Спорт и тренировки': 'sport', 'Горнолыжка': 'sport', 'Велосипед': 'sport',
    'Походы и прогулки на природе': 'trip_outdoors', 'Поездки за город': 'trip_outdoors'
  };
  const goals = [...new Set(activities.map(a => map[a] || 'other'))] as Goal[];
  return { goals, goal: goals[0], customGoal: activities.filter(a => !map[a]).join(', ').slice(0, 30) };
}
