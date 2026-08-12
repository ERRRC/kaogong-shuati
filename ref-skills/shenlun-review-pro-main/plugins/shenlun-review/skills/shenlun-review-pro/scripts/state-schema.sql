-- shenlun-review SQLite state schema v2
-- Created at runtime by review_engine.py; not shipped as a pre-built database.
-- All queries must use parameterized execution. Foreign keys are enabled.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '3');

CREATE TABLE IF NOT EXISTS materials (
    material_id TEXT PRIMARY KEY,
    material_hash TEXT NOT NULL UNIQUE,
    source_type TEXT,
    paragraph_count INTEGER,
    word_count INTEGER,
    quality TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    question_type TEXT NOT NULL,
    task_instruction TEXT NOT NULL,
    word_limit INTEGER,
    full_score REAL,
    identity TEXT,
    document_type TEXT,
    audience TEXT,
    analysis_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (analysis_id),
    FOREIGN KEY (material_id) REFERENCES materials(material_id)
);

CREATE TABLE IF NOT EXISTS material_points (
    point_key TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    point_id TEXT NOT NULL,
    paragraph_id TEXT,
    evidence_text TEXT NOT NULL,
    point_text TEXT NOT NULL,
    point_role TEXT,
    importance TEXT,
    independent_scoring INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    UNIQUE (task_id, point_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

CREATE TABLE IF NOT EXISTS answers (
    answer_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    answer_version TEXT NOT NULL,
    user_answer TEXT NOT NULL,
    word_count INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);

-- point_mappings: bound to score_id so same answer with different scores don't collide
CREATE TABLE IF NOT EXISTS point_mappings (
    mapping_id TEXT PRIMARY KEY,
    score_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,
    point_key TEXT NOT NULL,
    coverage_status TEXT NOT NULL,
    user_quote TEXT,
    UNIQUE (score_id, point_key),
    FOREIGN KEY (answer_id) REFERENCES answers(answer_id),
    FOREIGN KEY (point_key) REFERENCES material_points(point_key),
    FOREIGN KEY (score_id) REFERENCES scores(score_id)
);

-- extra_claims: "超出材料" entries, bound to score_id
CREATE TABLE IF NOT EXISTS extra_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    score_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    claim_text TEXT NOT NULL,
    UNIQUE (score_id, claim_id),
    FOREIGN KEY (score_id) REFERENCES scores(score_id),
    FOREIGN KEY (answer_id) REFERENCES answers(answer_id)
);

CREATE TABLE IF NOT EXISTS scores (
    score_id TEXT PRIMARY KEY,
    answer_id TEXT NOT NULL,
    analysis_id TEXT NOT NULL,
    weight_total REAL NOT NULL,
    score_base REAL NOT NULL,
    diagnostic_total REAL NOT NULL,
    raw_center REAL NOT NULL,
    center_value REAL NOT NULL,
    interval_lower REAL NOT NULL,
    interval_upper REAL NOT NULL,
    confidence TEXT NOT NULL,
    weight_policy TEXT NOT NULL,
    weight_source_note TEXT,
    full_score REAL,
    scoring_json TEXT NOT NULL,
    validation_passed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (answer_id) REFERENCES answers(answer_id)
);

CREATE TABLE IF NOT EXISTS dimension_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    score_id TEXT NOT NULL,
    dimension_name TEXT NOT NULL,
    weight REAL NOT NULL,
    level INTEGER NOT NULL,
    calculated_score REAL NOT NULL,
    note TEXT,
    FOREIGN KEY (score_id) REFERENCES scores(score_id)
);

CREATE TABLE IF NOT EXISTS revisions (
    revision_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    draft_1_score_id TEXT,
    draft_2_score_id TEXT,
    comparison_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (draft_1_score_id) REFERENCES scores(score_id),
    FOREIGN KEY (draft_2_score_id) REFERENCES scores(score_id)
);

CREATE TABLE IF NOT EXISTS method_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    score_id TEXT NOT NULL,
    method_card_id TEXT NOT NULL,
    UNIQUE (score_id, method_card_id),
    FOREIGN KEY (score_id) REFERENCES scores(score_id)
);

CREATE TABLE IF NOT EXISTS ability_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    question_type TEXT NOT NULL,
    dimension_name TEXT NOT NULL,
    level INTEGER NOT NULL,
    score_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (score_id) REFERENCES scores(score_id)
);

CREATE TABLE IF NOT EXISTS calibrations (
    calibration_id TEXT PRIMARY KEY,
    score_id TEXT NOT NULL,
    calibration_source TEXT NOT NULL,
    original_center REAL NOT NULL,
    calibrated_score REAL NOT NULL,
    deviation REAL NOT NULL,
    deviation_analysis TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (score_id) REFERENCES scores(score_id)
);

CREATE INDEX IF NOT EXISTS idx_scores_answer ON scores(answer_id);
CREATE INDEX IF NOT EXISTS idx_point_mappings_score ON point_mappings(score_id);
CREATE INDEX IF NOT EXISTS idx_extra_claims_score ON extra_claims(score_id);
CREATE INDEX IF NOT EXISTS idx_dimension_scores_score ON dimension_scores(score_id);
CREATE INDEX IF NOT EXISTS idx_ability_events_type_dim ON ability_events(question_type, dimension_name);
CREATE INDEX IF NOT EXISTS idx_material_points_task ON material_points(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_analysis ON tasks(analysis_id);
