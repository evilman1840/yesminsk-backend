import { User } from './models/User';
import { deleteAvatar } from './avatars';

/**
 * Пользовательское соглашение и Политика (тексты — во фронте, src/texts/legal.ts).
 * Обновили редакцию: поменяйте LEGAL_VERSION здесь и во фронте и сдвиньте LEGAL_GRACE_UNTIL
 * на ~2 недели вперёд — столько анкеты не принявших ещё видны другим
 */
export const LEGAL_VERSION = '2026-10-25';
export const LEGAL_GRACE_UNTIL = new Date('2026-11-08T00:00:00+03:00');

// Условие для показа анкеты другим: после льготного срока — только принявшие текущую редакцию
export const legalVisibleQuery = (): Record<string, any> => (Date.now() > LEGAL_GRACE_UNTIL.getTime() ? { legalVersion: LEGAL_VERSION } : {});

// Записи тех, кто открыл приложение, но не дал согласия (создавались до этой версии), — удаляем
export async function removeNonConsented() {
  try {
    const stale = await User.find(
      { hasAgreedToRules: { $ne: true }, profileCompleted: { $ne: true }, createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      { telegramId: 1 }
    ).lean();
    if (!stale.length) return;
    const ids = stale.map((u) => u.telegramId);
    await Promise.all(ids.map((id) => deleteAvatar(id)));
    const r = await User.deleteMany({ telegramId: { $in: ids }, hasAgreedToRules: { $ne: true }, profileCompleted: { $ne: true } });
    console.log(`🧹 Удалены записи без согласия: ${r.deletedCount}`);
  } catch (err: any) {
    console.warn('⚠️ Удаление записей без согласия:', err?.message || err);
  }
}
