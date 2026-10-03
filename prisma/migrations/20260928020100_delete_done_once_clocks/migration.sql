DELETE FROM "Reminders"
WHERE status = 'done'
  AND (repeat = 'once' OR repeat = '');
