import { CORE_QUESTIONS, EXTRA_QUESTIONS, PERSONAL_QUESTIONS, QUESTIONNAIRE_VERSION, Questionnaire } from './questionnaire';
import { AREA_GROUPS } from './areas';
const areas = AREA_GROUPS.flatMap(g => Object.keys(g.areas));
const suburbs = Object.keys(AREA_GROUPS.find(g => g.title === 'Рядом с Минском')!.areas);
const text = (v: unknown) => typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 150) : '';
/** Reject malformed payloads; retain only catalogued answers. Never accept visibility through truthy strings. */
export function cleanQuestionnaire(input: unknown): Questionnaire {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Не получилось прочитать ответы анкеты');
  const data = input as Record<string, unknown>;
  const result: any = { version: QUESTIONNAIRE_VERSION };
  for (const field of [...CORE_QUESTIONS, ...EXTRA_QUESTIONS]) {
    const raw = data[field.key];
    if (raw === undefined) continue;
    const allowed = field.key === 'meetingAreas' ? ['Весь Минск', ...areas] : field.options;
    if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string' || !allowed.includes(x))) throw new Error('Выбери ответы из предложенных вариантов');
    let selected = [...new Set(raw as string[])];
    if (selected.length > field.max) throw new Error(`Можно выбрать не больше ${field.max} вариантов`);
    if (field.exclusive && selected.includes(field.exclusive)) selected = [field.exclusive];
    if (field.key === 'meetingAreas' && selected.includes('Весь Минск')) selected = selected.filter(x => x === 'Весь Минск' || suburbs.includes(x));
    result[field.key] = selected;
  }
  const fav = data.favouriteActivity;
  if (typeof fav === 'string' && result.activities?.includes(fav)) result.favouriteActivity = fav;
  result.wantDetails = result.wants?.length ? text(data.wantDetails) : ''; result.offerDetails = result.offers?.length ? text(data.offerDetails) : '';
  result.personal = {};
  if (data.personal && typeof data.personal === 'object' && !Array.isArray(data.personal)) {
    for (const f of PERSONAL_QUESTIONS) {
      const answer = (data.personal as any)[f.key];
      if (!answer) continue;
      if (!Array.isArray(answer.values) || answer.values.length > f.max || answer.values.some((x: unknown) => typeof x !== 'string' || !f.options.includes(x))) throw new Error('Проверь личные ответы анкеты');
      const values = [...new Set(answer.values as string[])];
      if (values.length) result.personal[f.key] = { values, visible: answer.visible === true };
    }
  }
  return result;
}
/** The only questionnaire projection permitted in another person's profile. */
export function publicQuestionnaire(input: unknown): Questionnaire | undefined {
  if (!input) return undefined;
  try {
    const cleaned = cleanQuestionnaire(input);
    return { ...cleaned, personal: Object.fromEntries(Object.entries(cleaned.personal || {}).filter(([, a]) => a.visible === true)) };
  } catch { return undefined; }
}
