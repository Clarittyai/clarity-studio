/**
 * The local database schema.
 *
 * Deliberately built on Node's own `node:sqlite` rather than `better-sqlite3`.
 * Studio's whole pitch is that it runs on your machine, and a native module
 * turns `npm install` into "do you have a C++ toolchain and the right Python?"
 * — which on Windows is exactly the wall that makes people give up. Zero native
 * dependencies is worth more here than a marginally faster driver.
 *
 * Everything is local and user-owned. There is no sync, no server, and no row
 * that leaves this file.
 */

export const SCHEMA_VERSION = 1;

export const MIGRATIONS: string[] = [
  `
  -- One automation the user is working on.
  CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    slug          TEXT NOT NULL UNIQUE,
    path          TEXT NOT NULL,
    manifest_path TEXT,
    host_port     INTEGER,
    runtime       TEXT NOT NULL DEFAULT 'docker',   -- 'docker' | 'native'
    status        TEXT NOT NULL DEFAULT 'stopped',
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    archived_at   INTEGER
  );

  -- Host ports are a shared resource; a table makes collisions impossible
  -- rather than unlikely.
  CREATE TABLE IF NOT EXISTS ports (
    host_port    INTEGER PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    allocated_at INTEGER NOT NULL
  );

  -- A workflow execution. idempotency_key is UNIQUE because the SDK's
  -- get_workflow_run is a permanent stub that always returns None, so the
  -- double-fire guard has to live here rather than in the automation.
  CREATE TABLE IF NOT EXISTS runs (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    workflow_id        TEXT,
    agent_id           TEXT,
    trigger_instance_id TEXT,
    triggered_by       TEXT NOT NULL DEFAULT 'manual',
    idempotency_key    TEXT UNIQUE,
    status             TEXT NOT NULL DEFAULT 'running',
    started_at         INTEGER NOT NULL,
    ended_at           INTEGER,
    inputs             TEXT,
    outputs            TEXT,
    error              TEXT,
    prompt_tokens      INTEGER NOT NULL DEFAULT 0,
    completion_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_micros        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS runs_project_started ON runs(project_id, started_at DESC);

  -- One row per step, updated in place: a step checkpoints twice (running,
  -- then terminal) and the timeline should show one row, not two.
  CREATE TABLE IF NOT EXISTS run_steps (
    run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id    TEXT NOT NULL,
    status     TEXT NOT NULL,
    attempt    INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    input      TEXT,
    output     TEXT,
    error      TEXT,
    PRIMARY KEY (run_id, step_id)
  );

  -- Every model call, so "what did this cost" is answerable per run, per
  -- project and per day — including on your own key, where nobody else is
  -- keeping score.
  CREATE TABLE IF NOT EXISTS llm_calls (
    id                TEXT PRIMARY KEY,
    run_id            TEXT,
    step_id           TEXT,
    agent_id          TEXT,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_micros       INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,
    at                INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS llm_calls_run ON llm_calls(run_id);

  -- A user-configured instance of a trigger the automation declares.
  CREATE TABLE IF NOT EXISTS trigger_instances (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    recipe_trigger_id TEXT NOT NULL,
    workflow_id       TEXT,
    type              TEXT NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    schedule          TEXT,
    config            TEXT,
    timezone          TEXT,
    next_run_at       INTEGER,
    last_run_at       INTEGER,
    last_status       TEXT,
    last_error        TEXT,
    missed_count      INTEGER NOT NULL DEFAULT 0,
    missed_policy     TEXT NOT NULL DEFAULT 'skip'
  );

  -- Every webhook delivery, kept whole so it can be replayed. Cloud does not
  -- offer this, and it is the reason a developer keeps Studio installed.
  CREATE TABLE IF NOT EXISTS trigger_executions (
    id              TEXT PRIMARY KEY,
    instance_id     TEXT NOT NULL REFERENCES trigger_instances(id) ON DELETE CASCADE,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    success         INTEGER,
    http_status     INTEGER,
    error           TEXT,
    run_id          TEXT,
    request_headers TEXT,
    request_body    TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];
