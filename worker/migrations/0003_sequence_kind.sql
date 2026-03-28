-- Timeline cards: dedicated kind + clearer prompts (matches app UI for "sequence" drills)

UPDATE cards SET card_kind = 'sequence' WHERE item_id IN (SELECT id FROM items WHERE kind = 'timeline');

UPDATE cards SET
  front = 'Apollo 11 (example)

What is the very next step in this sequence?

You just completed:
Launch from Kennedy Space Center',
  back = 'Lunar module lands on the Moon'
WHERE id = 'seed-sample-time-c1';

UPDATE cards SET
  front = 'Apollo 11 (example)

What is the very next step in this sequence?

You just completed:
Lunar module lands on the Moon',
  back = 'Splashdown in the Pacific'
WHERE id = 'seed-sample-time-c2';
