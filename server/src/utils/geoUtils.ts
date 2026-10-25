/**
 * Смещение координат [lng, lat] на случайный радиус от 500 до 800 метров
 * с равномерным распределением по окружности.
 */
export function obfuscateCoordinates(
  lng: number,
  lat: number,
  minRadiusMeters: number = 500,
  maxRadiusMeters: number = 800
): [number, number] {
  const EARTH_RADIUS = 6378137; // Радиус Земли в метрах
  const randomDistance = minRadiusMeters + Math.random() * (maxRadiusMeters - minRadiusMeters);
  const randomAngle = Math.random() * 2 * Math.PI;

  const deltaLat = (randomDistance * Math.cos(randomAngle)) / EARTH_RADIUS;
  const deltaLng = (randomDistance * Math.sin(randomAngle)) / (EARTH_RADIUS * Math.cos((lat * Math.PI) / 180));

  const fuzzyLat = lat + (deltaLat * 180) / Math.PI;
  const fuzzyLng = lng + (deltaLng * 180) / Math.PI;

  return [
    Number(fuzzyLng.toFixed(6)),
    Number(fuzzyLat.toFixed(6))
  ];
}

/**
 * Расчёт дистанции между точками в метрах (формула Haversine)
 */
export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}
