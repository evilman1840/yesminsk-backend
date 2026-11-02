/**
 * День и время из живой фразы по Минску: «пятница 19:00», «завтра в 18:30», «7.11 в 12», «8 ноября 19.30», «в субботу в 7 вечера».
 * Нет дня — ближайший: сегодня, если время ещё впереди, иначе завтра. Нет времени — просим дописать
 */

const MINSK = 3 * 60 * 60 * 1000; // UTC+3 круглый год
const NOT_LETTER = '(?:^|[^а-я])';
const END = '(?=[^а-я]|$)';

const WEEKDAYS: [RegExp, number][] = [
  [new RegExp(`${NOT_LETTER}(?:пн|понедельник\\S*)${END}`), 1],
  [new RegExp(`${NOT_LETTER}(?:вт|вторник\\S*)${END}`), 2],
  [new RegExp(`${NOT_LETTER}(?:ср|сред[аеуы])${END}`), 3],
  [new RegExp(`${NOT_LETTER}(?:чт|четверг\\S*)${END}`), 4],
  [new RegExp(`${NOT_LETTER}(?:пт|пятниц[аеуы])${END}`), 5],
  [new RegExp(`${NOT_LETTER}(?:сб|суббот[аеуы])${END}`), 6],
  [new RegExp(`${NOT_LETTER}(?:вс|воскресень[еяю])${END}`), 0]
];
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма[йя]', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

export type ParsedTime = { at: Date } | { error: 'noTime' | 'bad' };

export function parseRuTime(input: string, now = new Date()): ParsedTime {
  let s = ` ${input.toLowerCase().replace(/ё/g, 'е')} `;
  const local = new Date(now.getTime() + MINSK); // «сейчас» по Минску в UTC-полях
  let hour: number | null = null;
  let minute = 0;
  let date: { d: number; m: number; y?: number } | null = null;
  let addDays: number | null = null;
  let weekday: number | null = null;
  const cut = (re: RegExp) => (s = s.replace(re, ' '));

  // 1. Время через двоеточие: 19:00
  let m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) {
    hour = +m[1];
    minute = +m[2];
    cut(/(\d{1,2}):(\d{2})/);
  }
  // 2. «в 19.30» — время через точку после предлога
  if (hour === null && (m = s.match(/[^а-я](?:в|к)\s*(\d{1,2})\.(\d{2})(?!\d)/))) {
    hour = +m[1];
    minute = +m[2];
    cut(/[^а-я](?:в|к)\s*(\d{1,2})\.(\d{2})(?!\d)/);
  }
  // 3. «8 ноября»
  const monthRe = new RegExp(`(\\d{1,2})\\s*(${MONTHS.join('|')})[а-я]*`);
  if ((m = s.match(monthRe))) {
    date = { d: +m[1], m: MONTHS.findIndex((x) => new RegExp(`^${x}`).test(m![2])) };
    cut(monthRe);
  }
  // 4. «7.11», «07/11», «7.11.2026»; «19.30» без предлога — тоже время, раз месяца 30 не бывает
  if (!date && (m = s.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/))) {
    if (+m[2] >= 1 && +m[2] <= 12) date = { d: +m[1], m: +m[2] - 1, y: m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : undefined };
    else if (hour === null) {
      hour = +m[1];
      minute = +m[2];
    }
    cut(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/);
  }
  // «8 ноября 19.30»: день уже есть — оставшееся «чч.мм» это время
  if (hour === null && date && (m = s.match(/(\d{1,2})\.(\d{2})(?!\d)/))) {
    hour = +m[1];
    minute = +m[2];
  }
  // 5. Только часы: «в 19», «к 7 вечера», «19 ч»
  if (hour === null && (m = s.match(/[^а-я\d](?:в|к)\s*(\d{1,2})(?!\d)/) || s.match(/(\d{1,2})\s*(?:ч|час)/))) hour = +m[1];
  // Вечер и день: «в 7 вечера» → 19:00, «в 3 дня» → 15:00
  if (hour !== null && hour < 12 && (/вечер/.test(s) || (/[^а-я]дня/.test(s) && hour <= 6))) hour += 12;

  // День: сегодня / завтра / послезавтра / день недели
  if (/послезавтра/.test(s)) addDays = 2;
  else if (/завтра/.test(s)) addDays = 1;
  else if (/сегодня/.test(s)) addDays = 0;
  else for (const [re, wd] of WEEKDAYS) if (re.test(s)) weekday = wd;

  const hasDay = date !== null || addDays !== null || weekday !== null;
  if (hour === null) return { error: hasDay ? 'noTime' : 'bad' };
  if (hour > 23 || minute > 59) return { error: 'bad' };

  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  const at = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd, hour!, minute) - MINSK);

  if (date) {
    if (date.d < 1 || date.d > 31 || date.m < 0) return { error: 'bad' };
    let res = at(date.y ?? y, date.m, date.d);
    // «5.01» в ноябре — это январь следующего года
    if (date.y === undefined && res.getTime() < now.getTime() - 24 * 60 * 60 * 1000) res = at(y + 1, date.m, date.d);
    return { at: res };
  }
  if (addDays !== null) return { at: at(y, mo, d + addDays) };
  if (weekday !== null) {
    let diff = (weekday - local.getUTCDay() + 7) % 7;
    if (diff === 0 && at(y, mo, d).getTime() <= now.getTime()) diff = 7;
    return { at: at(y, mo, d + diff) };
  }
  // Только время: сегодня, если ещё впереди, иначе завтра
  const today = at(y, mo, d);
  return { at: today.getTime() > now.getTime() ? today : at(y, mo, d + 1) };
}
