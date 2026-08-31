-- shenlun-review SQLite state schema v4
-- Created at runtime by review_engine.py; not shipped as a pre-built database.
-- All queries must use parameterized execution. Foreign keys are enabled.
-- v4 adds: papers, questions, task_specs, task_components, reference_answer_sets,
--          reference_answer_items, point_ledgers, structure_ledgers

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '4');

-- v3 tables (preserved)
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

-- v4 new tables

CREATE TABLE IF NOT EXISTS papers (
    paper_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_file TEXT,
    source_hash TEXT,
    material_sections_json TEXT,
    completeness_json TEXT,
    issues_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
    question_key TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    paper_id TEXT NOT NULL,
    question_type TEXT NOT NULL,
    material_scope_json TEXT,
    is_essay INTEGER NOT NULL DEFAULT 0,
    essay_material_scope TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (paper_id, question_id),
    FOREIGN KEY (paper_id) REFERENCES papers(paper_id)
);

CREATE TABLE IF NOT EXISTS task_specs (
    task_spec_id TEXT PRIMARY KEY,
    question_key TEXT NOT NULL,
    paper_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_instruction TEXT NOT NULL,
    material_scope_json TEXT,
    full_score REAL,
    identity TEXT,
    audience TEXT,
    purpose TEXT,
    output_genre TEXT,
    primary_prototype_id TEXT,
    required_content_elements_json TEXT,
    optional_content_elements_json TEXT,
    required_format_elements_json TEXT,
    relation_requirements_json TEXT,
    style_requirements_json TEXT,
    min_length INTEGER,
    max_length INTEGER,
    length_unit TEXT DEFAULT '字',
    subtasks_json TEXT,
    shared_length_limit INTEGER,
    uncertainty_json TEXT,
    spec_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (paper_id) REFERENCES papers(paper_id),
    FOREIGN KEY (question_key) REFERENCES questions(question_key)
);

CREATE TABLE IF NOT EXISTS task_components (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_spec_id TEXT NOT NULL,
    component_name TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    UNIQUE (task_spec_id, component_name),
    FOREIGN KEY (task_spec_id) REFERENCES task_specs(task_spec_id)
);

CREATE TABLE IF NOT EXISTS reference_answer_sets (
    reference_set_id TEXT PRIMARY KEY,
    question_key TEXT NOT NULL,
    paper_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    source_confidence TEXT NOT NULL DEFAULT 'low',
    consensus_json TEXT,
    disputed_json TEXT,
    equivalent_expressions_json TEXT,
    structure_variants_json TEXT,
    issues_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (paper_id) REFERENCES papers(paper_id),
    FOREIGN KEY (question_key) REFERENCES questions(question_key)
);

CREATE TABLE IF NOT EXISTS reference_answer_items (
    answer_item_id TEXT PRIMARY KEY,
    reference_set_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,
    label TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_note TEXT,
    reliability TEXT DEFAULT 'low',
    answer_text TEXT NOT NULL,
    supported_point_ids_json TEXT,
    structure_summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reference_set_id) REFERENCES reference_answer_sets(reference_set_id)
);

CREATE TABLE IF NOT EXISTS score_ledgers (
    ledger_id TEXT PRIMARY KEY,
    score_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,
    question_key TEXT NOT NULL,
    schema_version TEXT NOT NULL DEFAULT '1.0',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (score_id) REFERENCES scores(score_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (answer_id) REFERENCES answers(answer_id),
    FOREIGN KEY (question_key) REFERENCES questions(question_key)
);

CREATE TABLE IF NOT EXISTS point_ledgers (
    point_ledger_id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,
    score_id TEXT NOT NULL,
    point_id TEXT NOT NULL,
    point_key TEXT NOT NULL,
    task_component_ids_json TEXT,
    material_evidence TEXT NOT NULL,
    user_quote TEXT,
    match_type TEXT NOT NULL,
    coverage_status TEXT NOT NULL,
    credit_reason TEXT,
    loss_reason TEXT,
    deduction_owner TEXT,
    modification_action TEXT,
    reference_support TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ledger_id, point_id),
    UNIQUE (score_id, point_key),
    FOREIGN KEY (ledger_id) REFERENCES score_ledgers(ledger_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (answer_id) REFERENCES answers(answer_id),
    FOREIGN KEY (score_id) REFERENCES scores(score_id),
    FOREIGN KEY (point_key) REFERENCES material_points(point_key)
);

CREATE TABLE IF NOT EXISTS structure_ledgers (
    structure_ledger_id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    answer_id TEXT NOT NULL,
    score_id TEXT NOT NULL,
    element_id TEXT NOT NULL,
    element_type TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    basis TEXT,
    user_evidence TEXT,
    status TEXT NOT NULL,
    credit_reason TEXT,
    loss_reason TEXT,
    deduction_owner TEXT,
    modification_action TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (score_id, element_id),
    FOREIGN KEY (ledger_id) REFERENCES score_ledgers(ledger_id),
    FOREIGN KEY (task_id) REFERENCES tasks(task_id),
    FOREIGN KEY (answer_id) REFERENCES answers(answer_id),
    FOREIGN KEY (score_id) REFERENCES scores(score_id)
);

-- Indexes (v3 preserved + v4 new)
CREATE INDEX IF NOT EXISTS idx_scores_answer ON scores(answer_id);
CREATE INDEX IF NOT EXISTS idx_point_mappings_score ON point_mappings(score_id);
CREATE INDEX IF NOT EXISTS idx_extra_claims_score ON extra_claims(score_id);
CREATE INDEX IF NOT EXISTS idx_dimension_scores_score ON dimension_scores(score_id);
CREATE INDEX IF NOT EXISTS idx_ability_events_type_dim ON ability_events(question_type, dimension_name);
CREATE INDEX IF NOT EXISTS idx_material_points_task ON material_points(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_analysis ON tasks(analysis_id);
CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_task_specs_paper ON task_specs(paper_id);
CREATE INDEX IF NOT EXISTS idx_task_specs_question ON task_specs(question_id);
CREATE INDEX IF NOT EXISTS idx_task_components_spec ON task_components(task_spec_id);
CREATE INDEX IF NOT EXISTS idx_ref_answer_sets_question ON reference_answer_sets(question_id);
CREATE INDEX IF NOT EXISTS idx_ref_answer_items_set ON reference_answer_items(reference_set_id);
CREATE INDEX IF NOT EXISTS idx_point_ledgers_task ON point_ledgers(task_id);
CREATE INDEX IF NOT EXISTS idx_point_ledgers_answer ON point_ledgers(answer_id);
CREATE INDEX IF NOT EXISTS idx_structure_ledgers_task ON structure_ledgers(task_id);
CREATE INDEX IF NOT EXISTS idx_structure_ledgers_answer ON structure_ledgers(answer_id);
