-- Demo content: "Sample" folder with one flashcard, one MCQ, and one timeline (two linked cards).

INSERT INTO folders (id, parent_id, name, sort_order, created_at) VALUES
  ('sample', NULL, 'Sample', 1, (CAST(strftime('%s', 'now') AS INTEGER) * 1000));

-- Flashcard
INSERT INTO items (id, folder_id, kind, title, content_json, created_at, updated_at) VALUES
  (
    'seed-sample-flash',
    'sample',
    'flashcard',
    NULL,
    '{"question":"What does FSRS stand for in this app?","answer":"Free Spaced Repetition Scheduler — the scheduling algorithm used for your reviews."}',
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  );

INSERT INTO cards (id, item_id, folder_id, card_kind, front, back, mcq_json, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) VALUES
  (
    'seed-sample-flash-c',
    'seed-sample-flash',
    'sample',
    'flashcard',
    'What does FSRS stand for in this app?',
    'Free Spaced Repetition Scheduler — the scheduling algorithm used for your reviews.',
    NULL,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    0, 0, 0, 0, 0, 0, 0, 0, NULL,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  );

-- MCQ (one correct, three distractors)
INSERT INTO items (id, folder_id, kind, title, content_json, created_at, updated_at) VALUES
  (
    'seed-sample-mcq',
    'sample',
    'mcq',
    NULL,
    '{"question":"Which planet is the largest in our solar system?","options":[{"text":"Jupiter","correct":true},{"text":"Saturn","correct":false},{"text":"Neptune","correct":false},{"text":"Earth","correct":false}]}',
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  );

INSERT INTO cards (id, item_id, folder_id, card_kind, front, back, mcq_json, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) VALUES
  (
    'seed-sample-mcq-c',
    'seed-sample-mcq',
    'sample',
    'mcq',
    NULL,
    NULL,
    '{"question":"Which planet is the largest in our solar system?","options":[{"text":"Jupiter","correct":true},{"text":"Saturn","correct":false},{"text":"Neptune","correct":false},{"text":"Earth","correct":false}],"explanation":null}',
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    0, 0, 0, 0, 0, 0, 0, 0, NULL,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  );

-- Timeline (3 events → 2 “what comes next?” cards)
INSERT INTO items (id, folder_id, kind, title, content_json, created_at, updated_at) VALUES
  (
    'seed-sample-time',
    'sample',
    'timeline',
    'Apollo 11 (example)',
    '{"title":"Apollo 11 (example)","events":["Launch from Kennedy Space Center","Lunar module lands on the Moon","Splashdown in the Pacific"]}',
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  );

INSERT INTO cards (id, item_id, folder_id, card_kind, front, back, mcq_json, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, created_at) VALUES
  (
    'seed-sample-time-c1',
    'seed-sample-time',
    'sample',
    'sequence',
    'Apollo 11 (example)
Launch from Kennedy Space Center',
    'Lunar module lands on the Moon',
    NULL,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    0, 0, 0, 0, 0, 0, 0, 0, NULL,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ),
  (
    'seed-sample-time-c2',
    'seed-sample-time',
    'sample',
    'sequence',
    'Apollo 11 (example)
Lunar module lands on the Moon',
    'Splashdown in the Pacific',
    NULL,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    0, 0, 0, 0, 0, 0, 0, 0, NULL,
    (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  );
