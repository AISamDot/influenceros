-- 0008 (IOS-2 fixes): every calendar slot carries its planned week. Seeded launch slots were written without
-- week_start, so week membership fell back to the UTC range and a west-of-UTC Sunday-evening post (Monday in UTC)
-- made the next week look planned. Backfill: the Monday of the post's date in the persona's time zone (UTC when the
-- stored zone is unknown to the database).
UPDATE calendar_slot s
   SET week_start = date_trunc('week', s.slot_at AT TIME ZONE COALESCE((SELECT z.name FROM pg_timezone_names z WHERE z.name = p.timezone LIMIT 1), 'UTC'))::date
  FROM persona p
 WHERE p.id = s.persona_id AND s.week_start IS NULL;
