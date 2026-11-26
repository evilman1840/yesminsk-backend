import { User } from '../models/User';

type ActionField = 'recentJoinAttempts' | 'recentWaveAttempts' | 'dailyWaveAttempts' | 'dailyBulkWaveAttempts';
type Limit = { field: ActionField; max: number; since: Date };

// Все лимиты для действия проверяются и обновляются одной операцией MongoDB.
export async function reserveRecentAction(telegramId: number, limits: Limit[]): Promise<boolean> {
  const now = new Date();
  const windows = limits.map(({ field, max, since }) => ({
    field,
    max,
    recent: {
      $filter: {
        input: { $ifNull: [`$${field}`, []] },
        as: 'attempt',
        cond: { $gt: ['$$attempt', since] }
      }
    }
  }));
  const result = await User.updateOne(
    {
      telegramId,
      hasAgreedToRules: true,
      isBanned: { $ne: true },
      $expr: { $and: windows.map(({ recent, max }) => ({ $lt: [{ $size: recent }, max] })) }
    },
    [{ $set: Object.fromEntries(windows.map(({ field, recent }) => [field, { $concatArrays: [recent, [now]] }])) }],
    { timestamps: false }
  );
  return result.matchedCount === 1;
}
