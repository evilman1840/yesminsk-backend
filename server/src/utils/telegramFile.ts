import { Response } from 'express';

/**
 * Отдаёт фото, хранящееся в Telegram (по file_id), через наш сервер — чтобы не раскрывать токен бота
 */
export async function sendTelegramPhoto(res: Response, fileId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const info: any = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)).json();
  if (!info.ok) return res.sendStatus(404);

  const file = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
  if (!file.ok) return res.sendStatus(502);

  res.setHeader('Content-Type', file.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.send(Buffer.from(await file.arrayBuffer()));
}
