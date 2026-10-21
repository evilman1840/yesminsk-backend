import { Place, PlaceImport, PlaceMood, PlacePrice } from './models/Place';
import { PLACES_IMPORT_2026_10_21 } from './data/places-2026-10-21';

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
}
