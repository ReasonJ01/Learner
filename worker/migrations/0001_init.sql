-- Learner D1 schema
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES ('timezone', 'UTC');
CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE);
CREATE INDEX idx_folders_parent ON folders(parent_id);
CREATE TABLE items (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, content_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE);
CREATE INDEX idx_items_folder ON items(folder_id);
CREATE TABLE cards (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, folder_id TEXT NOT NULL, card_kind TEXT NOT NULL, front TEXT, back TEXT, mcq_json TEXT, due INTEGER NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL, elapsed_days INTEGER NOT NULL DEFAULT 0, scheduled_days INTEGER NOT NULL DEFAULT 0, learning_steps INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0, last_review INTEGER, created_at INTEGER NOT NULL, FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE, FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE);
CREATE INDEX idx_cards_due ON cards(due);
CREATE INDEX idx_cards_folder ON cards(folder_id);
CREATE TABLE review_log (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, rating INTEGER NOT NULL, reviewed_at INTEGER NOT NULL, latency_ms INTEGER, FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE);
CREATE INDEX idx_review_log_time ON review_log(reviewed_at);
INSERT INTO folders (id, parent_id, name, sort_order, created_at) VALUES ('inbox', NULL, 'Inbox', 0, (strftime('%s','now') * 1000));
