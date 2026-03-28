-- Compact sequence prompts for demo cards (if they still had long instructional text)

UPDATE cards SET
  front = 'Apollo 11 (example)
Launch from Kennedy Space Center',
  back = 'Lunar module lands on the Moon'
WHERE id = 'seed-sample-time-c1';

UPDATE cards SET
  front = 'Apollo 11 (example)
Lunar module lands on the Moon',
  back = 'Splashdown in the Pacific'
WHERE id = 'seed-sample-time-c2';
