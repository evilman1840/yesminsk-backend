/**
 * «С кем хочу общаться» из анкеты: пол и возраст компании.
 * Везде, где показываем людей друг другу (лента, «Тоже хотят», приглашения, 👋), уважаем настройки того, кого показываем
 */

// Раньше анкета по умолчанию сохраняла «возраст компании 18–45» — такие значения считаем «не указано»
export const LEGACY_DEFAULT_AGE = { min: 18, max: 45 };

/**
 * Условия «их предпочтения допускают меня» — для запроса в Mongo
 */
export function theirPreferencesAllow(me: any): any[] {
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

/**
 * То же для уже загруженной анкеты: допускают ли настройки them меня
 */
export function preferencesAllow(them: any, me: any): boolean {
  const pg = them?.preferredGender;
  if (pg && pg !== 'all' && pg !== me?.gender) return false;
  const range = them?.preferredAgeRange;
  if (!range || (range.min === LEGACY_DEFAULT_AGE.min && range.max === LEGACY_DEFAULT_AGE.max)) return true;
  const myAge = Number(me?.age) || 25;
  return myAge >= range.min && myAge <= range.max;
}
