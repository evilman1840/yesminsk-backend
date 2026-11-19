/** Запись на будущую или несостоявшуюся сходку не считается посещением. */
export interface AttendanceEvent {
  dateTime: Date | string;
  isActive?: boolean;
  participants?: { telegramId: number; noShowAt?: Date | null }[];
}

export function countAttendance(events: AttendanceEvent[], now = Date.now()): Map<number, number> {
  const counts = new Map<number, number>();
  for (const event of events) {
    if (event.isActive === false || !(new Date(event.dateTime).getTime() < now)) continue;
    const came = new Set((event.participants || []).filter((p) => !p.noShowAt).map((p) => p.telegramId));
    if (came.size < 2) continue;
    for (const id of came) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}
