import { User } from './models/User';
import { Event } from './models/Event';
import { sendTelegramMessage, escapeHtml } from './utils/telegramNotify';
import { isAdmin } from './news';

/**
 * /ideas — что люди вписывают в «✨ Своя идея» (в сходках и в анкетах).
 * Похожие написания склеиваем: «Караоке», «караоке!» и «КАРАОКЕ» — одна идея.
 * Подсказка, какие категории стоит сделать отдельными. Только для автора
 */

const TOP = 25;

// «Караоке!!» → «караоке», «Йога  в парке» → «йога в парке»
const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

interface Idea {
  events: number;
  profiles: number;
  spellings: Map<string, number>; // как писали — покажем самое частое написание
}

export async function handleIdeasCommand(message: any): Promise<boolean> {
  const text: string = (message.text || '').trim();
  if (!/^\/ideas\b/i.test(text)) return false;
  if (!isAdmin(message.from?.id)) return false;

  try {
    sendTelegramMessage(message.chat.id, await buildIdeas());
  } catch (err: any) {
    sendTelegramMessage(message.chat.id, `Не получилось собрать идеи: ${err?.message || err}`);
  }
  return true;
}

export async function buildIdeas(): Promise<string> {
  const [events, users] = await Promise.all([
    Event.find({ category: 'other', customCategory: { $nin: [null, ''] } }, { customCategory: 1 }).lean(),
    User.find({ goals: 'other', customGoal: { $nin: [null, ''] }, isBanned: { $ne: true } }, { customGoal: 1 }).lean()
  ]);

  const ideas = new Map<string, Idea>();
  const add = (raw: string | undefined, kind: 'events' | 'profiles') => {
    const original = (raw || '').trim();
    const key = normalize(original);
    if (!key) return;
    const idea = ideas.get(key) || { events: 0, profiles: 0, spellings: new Map() };
    idea[kind] += 1;
    idea.spellings.set(original, (idea.spellings.get(original) || 0) + 1);
    ideas.set(key, idea);
  };
  events.forEach((e) => add(e.customCategory, 'events'));
  users.forEach((u) => add(u.customGoal, 'profiles'));

  if (ideas.size === 0) {
    return '✨ <b>Свои идеи</b>\n\nПока никто ничего не вписал: ни в сходках, ни в анкетах.';
  }

  const sorted = [...ideas.values()].sort((a, b) => b.events + b.profiles - (a.events + a.profiles));
  const lines = sorted.slice(0, TOP).map((idea, i) => {
    const label = [...idea.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const where = [idea.events ? `сходок ${idea.events}` : '', idea.profiles ? `анкет ${idea.profiles}` : ''].filter(Boolean).join(' · ');
    return `${i + 1}. <b>${escapeHtml(label)}</b>: ${idea.events + idea.profiles} (${where})`;
  });

  return (
    `✨ <b>Свои идеи</b>\n` +
    `Сходок со своей идеей: ${events.length} · анкет: ${users.length} · разных идей: ${ideas.size}\n\n` +
    lines.join('\n') +
    (sorted.length > TOP ? `\n\n…и ещё ${sorted.length - TOP}` : '') +
    `\n\n<i>Популярное стоит сделать отдельной категорией.</i>`
  );
}
