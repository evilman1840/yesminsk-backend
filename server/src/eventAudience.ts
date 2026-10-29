/**
 * Для кого сходка: пол (все / только девушки / только мужчины) и возраст «от–до» — по желанию организатора.
 * Кому не подходит, тот сходку в ленте не видит и записаться не может; бот таким тоже не пишет
 */

export type AudienceGender = 'all' | 'female' | 'male';
export const AUDIENCE_GENDERS: AudienceGender[] = ['all', 'female', 'male'];

type Audience = { audienceGender?: string | null; ageMin?: number | null; ageMax?: number | null };
type Person = { gender?: string | null; age?: number | null };

const MIN_AGE = 18;
const MAX_AGE = 99;

export const AUDIENCE_TEXTS = {
  badAge: 'Проверь возраст: от 18 до 99, и «от» не больше «до»',
  hostGender: 'Выбрать «только девушки» или «только мужчины» можно, если это твой пол в анкете',
  onlyFemale: 'Эта сходка только для девушек',
  onlyMale: 'Эта сходка только для мужчин',
  needGender: 'Организатор собирает сходку для определённого пола. Укажи свой пол в анкете',
  age: (min?: number | null, max?: number | null) =>
    `Организатор собирает компанию ${min && max ? `${min}–${max} лет` : min ? `от ${min} лет` : `до ${max} лет`}`
};

/**
 * Разбор полей из формы. undefined — поле не прислали (при изменении сходки — не трогаем)
 */
export function cleanAudience(body: any, host: Person): { value?: Required<Audience>; error?: string } {
  if (body?.audienceGender === undefined && body?.ageMin === undefined && body?.ageMax === undefined) return {};
  const audienceGender: AudienceGender = AUDIENCE_GENDERS.includes(body.audienceGender) ? body.audienceGender : 'all';
  const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Math.floor(Number(v)));
  const ageMin = num(body.ageMin);
  const ageMax = num(body.ageMax);
  const bad = (n: number | null) => n !== null && (!Number.isFinite(n) || n < MIN_AGE || n > MAX_AGE);
  if (bad(ageMin) || bad(ageMax) || (ageMin !== null && ageMax !== null && ageMin > ageMax)) return { error: AUDIENCE_TEXTS.badAge };
  if (audienceGender !== 'all' && host.gender !== audienceGender) return { error: AUDIENCE_TEXTS.hostGender };
  return { value: { audienceGender, ageMin: ageMin === MIN_AGE ? null : ageMin, ageMax: ageMax === MAX_AGE ? null : ageMax } };
}

// Почему человеку нельзя на сходку; null — можно
export function audienceError(ev: Audience, u: Person | null): string | null {
  const g = ev.audienceGender;
  if (g === 'female' || g === 'male') {
    if (u?.gender !== 'female' && u?.gender !== 'male') return AUDIENCE_TEXTS.needGender;
    if (u.gender !== g) return g === 'female' ? AUDIENCE_TEXTS.onlyFemale : AUDIENCE_TEXTS.onlyMale;
  }
  const age = Number(u?.age) || 0;
  if ((ev.ageMin && age < ev.ageMin) || (ev.ageMax && age > ev.ageMax)) return AUDIENCE_TEXTS.age(ev.ageMin, ev.ageMax);
  return null;
}

// Условия для ленты: сходки, которые подходят этому человеку
export function audienceFeedQuery(u: Person | null): any[] {
  const g = u?.gender === 'female' || u?.gender === 'male' ? u.gender : null;
  const age = Number(u?.age) || 0;
  return [
    { audienceGender: { $in: [null, 'all', ...(g ? [g] : [])] } },
    { $or: [{ ageMin: null }, { ageMin: { $lte: age } }] },
    { $or: [{ ageMax: null }, { ageMax: { $gte: age } }] }
  ];
}

// Условия для рассылок о сходке: люди, которым она подходит
export function audienceUsersQuery(ev: Audience): any {
  const q: any = {};
  if (ev.audienceGender === 'female' || ev.audienceGender === 'male') q.gender = ev.audienceGender;
  if (ev.ageMin || ev.ageMax) q.age = { ...(ev.ageMin ? { $gte: ev.ageMin } : {}), ...(ev.ageMax ? { $lte: ev.ageMax } : {}) };
  return q;
}
