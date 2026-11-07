import { calculateDistanceMeters } from './geoUtils';

/**
 * Где человек на самом деле, для расстояния, фильтра «до N км», очков близости и метки на карте.
 * При регистрации всем ставится центр Минска; район потом выбирают в анкете, а точка оставалась в центре
 * (у 1586 человек на 05.11). Если точка — та самая по умолчанию, берём центр района из анкеты.
 * Районы — те же, что в приложении (yesminsk-app/src/config/areas.ts), [lat, lng]
 */
const AREA_POINTS: Record<string, [number, number]> = {
  'Немига / Центр': [53.9045, 27.552],
  'Троицкое предместье': [53.908, 27.5555],
  'Площадь Независимости / Вокзал': [53.893, 27.548],
  'Октябрьская': [53.8905, 27.574],
  'Площадь Победы': [53.9085, 27.575],
  'Осмоловка': [53.9115, 27.5612],
  'Комаровка': [53.919, 27.58],
  'Золотая Горка': [53.915, 27.585],
  'Парк Победы / Победителей': [53.924, 27.545],
  'Парк Челюскинцев': [53.924, 27.615],
  'Академия наук': [53.922, 27.6],
  'Восток / Маяк Минска': [53.9335, 27.653],
  'Уручье': [53.945, 27.688],
  'Зелёный Луг': [53.947, 27.607],
  'Цнянка': [53.962, 27.6],
  'Копище / Новая Боровая': [53.96, 27.65],
  'Степянка': [53.92, 27.7],
  'Лебяжий': [53.94, 27.48],
  'Веснянка': [53.933, 27.498],
  'Тракторный завод / Партизанский': [53.888, 27.623],
  'Серебрянка': [53.865, 27.62],
  'Ангарская': [53.879, 27.678],
  'Чижовка': [53.845, 27.63],
  'Шабаны': [53.837, 27.67],
  'Лошица': [53.84, 27.575],
  'Курасовщина': [53.855, 27.53],
  'Сельхозпосёлок': [53.832, 27.53],
  'Грушевка': [53.887, 27.518],
  'Розочка': [53.893111, 27.513537],
  'Пушкинская': [53.909, 27.496],
  'Запад': [53.903, 27.472],
  'Кунцевщина': [53.908, 27.465],
  'Каменная Горка': [53.91, 27.44],
  'Сухарево': [53.884, 27.437],
  'Масюковщина': [53.93, 27.46],
  'Юго-Запад': [53.87, 27.48],
  'Петровщина': [53.865, 27.49],
  'Малиновка': [53.85, 27.47],
  'Минск-Мир': [53.868, 27.54],
  'Дрозды': [53.94, 27.47],
  'Боровляны': [53.985, 27.675],
  'Колодищи': [53.945, 27.782],
  'Ждановичи': [53.947, 27.425],
  'Ратомка': [53.93, 27.35],
  'Тарасово': [53.92, 27.4],
  'Заславль': [54.008, 27.285],
  'Сеница': [53.825, 27.54],
  'Мачулищи': [53.775, 27.585],
  'Фаниполь': [53.75, 27.333],
  'Пушкинская / Запад': [53.909, 27.496]
};

const DEFAULT_LNG = 27.5615;
const DEFAULT_LAT = 53.9045;
const isDefaultPoint = (c?: number[]) => Boolean(c && c.length === 2 && Math.abs(c[0] - DEFAULT_LNG) < 1e-4 && Math.abs(c[1] - DEFAULT_LAT) < 1e-4);
const areaPoint = (u: any): [number, number] | null => {
  const p = AREA_POINTS[u?.areaName];
  return p ? [p[1], p[0]] : null; // [lng, lat]
};

// Своя точка (не та, что по умолчанию) или центр района. [lng, lat]
export function realPoint(u: any): [number, number] | null {
  const exact = u?.locationExact?.coordinates;
  if (exact?.length === 2 && !isDefaultPoint(exact)) return [exact[0], exact[1]];
  return areaPoint(u) || (exact?.length === 2 ? [exact[0], exact[1]] : null);
}

// Смещение 500–800 м, одно и то же для человека (из telegramId), чтобы метка не прыгала между загрузками
function stableOffset(lng: number, lat: number, seed: number): [number, number] {
  const r1 = (Math.sin(seed * 12.9898) * 43758.5453) % 1;
  const r2 = (Math.sin(seed * 78.233) * 12345.6789) % 1;
  const dist = 500 + Math.abs(r1) * 300;
  const angle = Math.abs(r2) * 2 * Math.PI;
  const dLat = (dist * Math.cos(angle)) / 6378137;
  const dLng = (dist * Math.sin(angle)) / (6378137 * Math.cos((lat * Math.PI) / 180));
  return [Number((lng + (dLng * 180) / Math.PI).toFixed(6)), Number((lat + (dLat * 180) / Math.PI).toFixed(6))];
}

// Метка, которую видят другие. [lng, lat]
export function shownPoint(u: any): [number, number] | null {
  const exact = u?.locationExact?.coordinates;
  const fuzzy = u?.locationFuzzy?.coordinates;
  if (exact?.length === 2 && isDefaultPoint(exact)) {
    const area = areaPoint(u);
    if (area && !isDefaultPoint(area)) return stableOffset(area[0], area[1], Number(u.telegramId) || 1);
  }
  if (fuzzy?.length === 2) return [fuzzy[0], fuzzy[1]];
  return exact?.length === 2 ? [exact[0], exact[1]] : null;
}

// Метры между мной (моя настоящая точка) и меткой другого человека
export function metersBetween(me: any, u: any): number | null {
  const a = realPoint(me);
  const b = shownPoint(u);
  return a && b ? calculateDistanceMeters(a[1], a[0], b[1], b[0]) : null;
}
