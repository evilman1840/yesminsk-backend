import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import sharp from 'sharp';
import { User } from './models/User';
import { avatarBytes, isOwnPhotoUrl } from './avatars';

/**
 * «Только с теми, у кого есть фото»: на главном фото анкеты должен быть виден человек.
 * Однотонный фон, лес, кот или картинка не считаются. Проверяет Claude Haiku, когда фото меняется;
 * результат — hasFacePhoto, а faceCheckedFor запоминает, какое именно фото проверено
 */

const MODEL = 'claude-haiku-5-5';

const Verdict = z.object({
  face: z.boolean().describe('true — на фото реальный человек, и его лицо различимо')
});

const SYSTEM = `Ты проверяешь главное фото анкеты в приложении для знакомств с друзьями.
Ответь face: true, если на фото реальный человек (именно фотография, не рисунок) и его лицо можно разглядеть.
Подходят: селфи, портрет, человек в очках или в профиль, человек на фоне природы или города, фото в компании, где видно лица.
Не подходят: пейзаж, природа, однотонный фон, животные, еда, предметы, текст, мемы, рисунки, мультяшки, аниме, аватарки-иллюстрации,
человек со спины, лицо полностью закрыто, человек настолько далеко, что лица не разобрать.`;

let client: Anthropic | null = null;
const getClient = () => (client ||= new Anthropic());

// Заглушки вместо фото: пусто, стоковое фото по умолчанию, значок приложения
export const isStubAvatar = (url?: string) => !isOwnPhotoUrl(url);

// Фото из Telegram (t.me/i/userpic/…): бывает .svg с картинкой внутри — достаём её
async function downloadTelegramPic(url: string): Promise<Buffer | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const body = Buffer.from(await r.arrayBuffer());
  if ((r.headers.get('content-type') || '').includes('svg') || url.endsWith('.svg')) {
    const m = body.toString('utf8').match(/data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)/);
    if (m) return Buffer.from(m[1], 'base64');
  }
  return body;
}

async function imageFor(telegramId: number, avatarUrl: string): Promise<Buffer | null> {
  if (avatarUrl.startsWith('avatar:')) return avatarBytes(telegramId);
  if (/^https:\/\//.test(avatarUrl)) return downloadTelegramPic(avatarUrl);
  return null;
}

// true/false — ответ; null — проверить не получилось (попробуем позже)
export async function photoHasFace(image: Buffer): Promise<boolean | null> {
  const jpeg = await sharp(image).rotate().flatten({ background: '#ffffff' }).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 1500, // с запасом: модель может сначала подумать, и при 200 ответ обрезался посреди JSON
    output_config: { effort: 'low', format: zodOutputFormat(Verdict) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: 'Видно ли на этом фото человека с различимым лицом?' }
        ]
      }
    ]
  });
  if (response.stop_reason === 'refusal') return false;
  return response.parsed_output?.face ?? null;
}

const running = new Set<number>();

/**
 * Проверить главное фото человека, если оно ещё не проверено. Можно вызывать сколько угодно раз:
 * уже проверенное фото повторно не отправляем
 */
export async function refreshFaceCheck(telegramId: number): Promise<void> {
  if (running.has(telegramId)) return;
  running.add(telegramId);
  try {
    const u = await User.findOne({ telegramId }, { avatarUrl: 1, faceCheckedFor: 1 }).lean();
    if (!u) return;
    const url = u.avatarUrl || '';
    if (u.faceCheckedFor === url) return;
    let face: boolean | null = false;
    if (!isStubAvatar(url)) {
      if (!process.env.ANTHROPIC_API_KEY) return;
      const image = await imageFor(telegramId, url);
      face = image ? await photoHasFace(image) : false;
    }
    if (face === null) return;
    // Пока проверяли, фото могли сменить — тогда результат не записываем
    await User.updateOne({ telegramId, avatarUrl: u.avatarUrl }, { $set: { hasFacePhoto: face, faceCheckedFor: url } });
  } catch (err: any) {
    console.warn('⚠️ Проверка лица на фото:', telegramId, err?.message || err);
  } finally {
    running.delete(telegramId);
  }
}

// После запуска сервера: проверяем фото, которые ещё не проверены (по одному, чтобы не нагружать сервер)
export async function backfillFaceChecks() {
  try {
    const ids = (
      await User.find(
        { hasAgreedToRules: true, isBanned: { $ne: true }, $expr: { $ne: [{ $ifNull: ['$faceCheckedFor', null] }, '$avatarUrl'] } },
        { telegramId: 1 }
      )
        .sort({ lastActiveAt: -1 })
        .limit(5000)
        .lean()
    ).map((u) => u.telegramId);
    if (!ids.length) return;
    console.log(`🙂 Проверка лиц на фото: ${ids.length} анкет`);
    for (const id of ids) {
      await refreshFaceCheck(id);
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log('✅ Проверка лиц на фото закончена');
  } catch (err: any) {
    console.warn('⚠️ Проверка лиц на фото:', err?.message || err);
  }
}
