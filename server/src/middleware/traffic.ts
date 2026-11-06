import { Request, Response, NextFunction } from 'express';

/**
 * Счётчик исходящего трафика по адресам: сколько байт (уже после сжатия) и запросов ушло.
 * Раз в час пишем в лог Render десять самых тяжёлых адресов и обнуляем счёт.
 * Ставить ДО compression(): тогда сюда приходят уже сжатые байты
 */
const stats = new Map<string, { bytes: number; count: number }>();
let since = Date.now();

// /api/users/123/avatar → /api/users/:id/avatar; длинные file_id фото — тоже :id
const bucket = (path: string) =>
  path
    .split('/')
    .slice(0, 5)
    .map((s) => (/^\d+$/.test(s) || s.length > 20 ? ':id' : s))
    .join('/');

export function trafficMeter(req: Request, res: Response, next: NextFunction) {
  let bytes = 0;
  const write = res.write.bind(res) as any;
  const end = res.end.bind(res) as any;
  const size = (chunk: any, enc?: any) =>
    !chunk || typeof chunk === 'function' ? 0 : Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8');
  (res as any).write = (chunk: any, ...rest: any[]) => {
    bytes += size(chunk, rest[0]);
    return write(chunk, ...rest);
  };
  (res as any).end = (chunk: any, ...rest: any[]) => {
    bytes += size(chunk, rest[0]);
    return end(chunk, ...rest);
  };
  res.on('finish', () => {
    const key = `${req.method} ${bucket(req.path)}`;
    const s = stats.get(key) || { bytes: 0, count: 0 };
    s.bytes += bytes;
    s.count++;
    stats.set(key, s);
  });
  next();
}

export function startTrafficReport() {
  setInterval(() => {
    const rows = [...stats.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
    const total = rows.reduce((n, [, s]) => n + s.bytes, 0);
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
    const min = Math.round((Date.now() - since) / 60000);
    console.log(
      `📦 Трафик за ${min} мин: ${mb(total)} МБ\n` +
        rows
          .slice(0, 10)
          .map(([k, s]) => `   ${mb(s.bytes).padStart(7)} МБ  ${String(s.count).padStart(6)} запр.  ${Math.round(s.bytes / Math.max(1, s.count) / 1024)} КБ/запр.  ${k}`)
          .join('\n')
    );
    stats.clear();
    since = Date.now();
  }, 60 * 60 * 1000).unref();
}
