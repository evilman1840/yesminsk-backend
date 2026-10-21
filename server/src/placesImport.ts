import { Place, PlaceImport, PlaceMood, PlacePrice } from './models/Place';
import { PLACES_IMPORT_2026_10_21 } from './data/places-2026-10-21';
import { PLACE_REVIEWS_2026_10_21 } from './data/reviews-2026-10-21';
import { PLACE_MOODS_2026_10_21 } from './data/moods-2026-10-21';

/**
 * Загрузка мест из таблиц автора. Каждая таблица применяется один раз:
 * новые места добавляются, у существующих (по названию) обновляются данные из таблицы.
 * Фото, отзывы людей, совет автора и правки из бота после импорта не трогаем
 */

export interface PlaceImportItem {
  name: string;
  category: string;
  rating: number | null;
  ratingCount: number | null;
  hours: string;
  phone: string;
  website: string;
  description: string;
  amenities: string[];
  address: string;
  mapUrl: string;
  coordinates: [number, number] | null; // [lat, lng]
  moods?: PlaceMood[];
  price?: PlacePrice;
  rainOk?: boolean;
  evening?: boolean;
  oneDay?: boolean;
}

// Отзыв из таблицы: к какому месту (по названию), оценка и текст
export interface PlaceReviewImport {
  place: string;
  rating: number | null;
  text: string;
}

const REVIEW_IMPORTS: { key: string; items: PlaceReviewImport[] }[] = [{ key: 'reviews-2026-10-21', items: PLACE_REVIEWS_2026_10_21 }];

const MOOD_IMPORTS: { key: string; items: { place: string; moods: PlaceMood[] }[] }[] = [{ key: 'moods-2026-10-21', items: PLACE_MOODS_2026_10_21 }];

const IMPORTS: { key: string; items: PlaceImportItem[] }[] = [{ key: 'places-2026-10-21', items: PLACES_IMPORT_2026_10_21 }];

export async function runPlaceImports() {
  for (const { key, items } of IMPORTS) {
    try {
      if (await PlaceImport.exists({ key })) continue;
      let created = 0;
      let updated = 0;
      for (const item of items) {
        if (!item.coordinates) continue;
        const tableFields = {
          category: item.category,
          description: item.description.slice(0, 300),
          address: item.address,
          mapUrl: item.mapUrl,
          location: { type: 'Point' as const, coordinates: [item.coordinates[1], item.coordinates[0]] as [number, number] },
          rating: item.rating ?? undefined,
          ratingCount: item.ratingCount ?? undefined,
          hours: item.hours,
          phone: item.phone,
          website: item.website,
          amenities: item.amenities
        };
        const existing = await Place.findOne({ name: item.name });
        if (existing) {
          existing.set(tableFields);
          await existing.save();
          updated++;
        } else {
          await Place.create({
            name: item.name,
            ...tableFields,
            moods: item.moods || [],
            price: item.price,
            rainOk: Boolean(item.rainOk),
            evening: Boolean(item.evening),
            oneDay: Boolean(item.oneDay),
            photos: []
          });
          created++;
        }
      }
      await PlaceImport.create({ key });
      console.log(`📍 Импорт мест «${key}»: добавлено ${created}, обновлено ${updated}`);
    } catch (err: any) {
      console.warn(`⚠️ Импорт мест «${key}» не удался:`, err?.message || err);
    }
  }

  // Отзывы — после мест, чтобы было к чему их прикрепить. Таблица заменяет отзывы этих мест целиком
  for (const { key, items } of REVIEW_IMPORTS) {
    try {
      if (await PlaceImport.exists({ key })) continue;
      const byPlace = new Map<string, PlaceReviewImport[]>();
      items.forEach((r) => byPlace.set(r.place, [...(byPlace.get(r.place) || []), r]));
      let added = 0;
      const missing: string[] = [];
      for (const [name, reviews] of byPlace) {
        const place = await Place.findOne({ name });
        if (!place) {
          missing.push(name);
          continue;
        }
        place.set(
          'reviews',
          reviews.map((r) => ({ rating: r.rating ?? undefined, text: r.text.slice(0, 600), source: 'Яндекс Карты' }))
        );
        await place.save();
        added += reviews.length;
      }
      // Не нашли какие-то места — не помечаем как загруженное, попробуем при следующем запуске
      if (missing.length) console.warn(`⚠️ Отзывы «${key}»: нет мест ${missing.join(', ')}`);
      else await PlaceImport.create({ key });
      console.log(`💬 Отзывы «${key}»: добавлено ${added}`);
    } catch (err: any) {
      console.warn(`⚠️ Импорт отзывов «${key}» не удался:`, err?.message || err);
    }
  }

  // Настроения от автора — заменяют те, что были у места
  for (const { key, items } of MOOD_IMPORTS) {
    try {
      if (await PlaceImport.exists({ key })) continue;
      const missing: string[] = [];
      for (const { place, moods } of items) {
        const res = await Place.updateOne({ name: place }, { $set: { moods } });
        if (!res.matchedCount) missing.push(place);
      }
      if (missing.length) console.warn(`⚠️ Настроения «${key}»: нет мест ${missing.join(', ')}`);
      else await PlaceImport.create({ key });
      console.log(`🌤 Настроения «${key}»: обновлено ${items.length - missing.length}`);
    } catch (err: any) {
      console.warn(`⚠️ Импорт настроений «${key}» не удался:`, err?.message || err);
    }
  }
}
