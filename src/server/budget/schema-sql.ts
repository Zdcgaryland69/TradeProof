// Schema v9: overall API budget ledger for LIVE model calls (all requests, all quote versions).
// One row per model ATTEMPT, written before the request is sent. A row starts RESERVED with the
// attempt's upper-bound cost and is closed exactly once: SETTLED (estimate from reported usage),
// RELEASED (definitely not sent) or UNKNOWN (may have been sent; the reserved amount stays counted).
// Closed rows are immutable and no row is ever deleted, so restarts, config or model changes never
// reset what has been spent. Amounts are integer micro-units of `currency`. MOCK runs never write here.

export const BUDGET_SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS ai_budget_ledger (
  id                   TEXT PRIMARY KEY CHECK (id GLOB 'abl_*'),
  request_key          TEXT NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 1 AND 200),
  purpose              TEXT NOT NULL CHECK (purpose IN ('QUOTE_EXTRACTION')),
  extraction_id        TEXT REFERENCES quote_extraction_runs(id),
  attempt              INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt >= 1),
  provider             TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 50),
  model                TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  currency             TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  reserved_micros      INTEGER NOT NULL CHECK (typeof(reserved_micros) = 'integer' AND reserved_micros >= 0),
  input_tokens_bound   INTEGER NOT NULL CHECK (typeof(input_tokens_bound) = 'integer' AND input_tokens_bound >= 0),
  output_tokens_bound  INTEGER NOT NULL CHECK (typeof(output_tokens_bound) = 'integer' AND output_tokens_bound >= 0),
  price_basis          TEXT NOT NULL CHECK (json_valid(price_basis)),
  state                TEXT NOT NULL CHECK (state IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNKNOWN')),
  input_tokens         INTEGER CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  output_tokens        INTEGER CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  settled_micros       INTEGER CHECK (settled_micros IS NULL OR (typeof(settled_micros) = 'integer' AND settled_micros >= 0)),
  outcome_note         TEXT CHECK (outcome_note IS NULL OR length(outcome_note) BETWEEN 1 AND 500),
  budget_day           TEXT NOT NULL CHECK (budget_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  reserved_at          TEXT NOT NULL,
  closed_at            TEXT,
  CHECK ((state = 'RESERVED') = (closed_at IS NULL)),
  CHECK ((state = 'SETTLED') = (settled_micros IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ai_budget_ledger_day ON ai_budget_ledger(budget_day);
CREATE INDEX IF NOT EXISTS ai_budget_ledger_state ON ai_budget_ledger(state, reserved_at);

CREATE TRIGGER IF NOT EXISTS ai_budget_ledger_close_once
BEFORE UPDATE ON ai_budget_ledger
WHEN OLD.state <> 'RESERVED'
  OR NEW.id IS NOT OLD.id OR NEW.request_key IS NOT OLD.request_key OR NEW.purpose IS NOT OLD.purpose
  OR NEW.extraction_id IS NOT OLD.extraction_id OR NEW.attempt IS NOT OLD.attempt
  OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.currency IS NOT OLD.currency
  OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.input_tokens_bound IS NOT OLD.input_tokens_bound
  OR NEW.output_tokens_bound IS NOT OLD.output_tokens_bound OR NEW.price_basis IS NOT OLD.price_basis
  OR NEW.budget_day IS NOT OLD.budget_day OR NEW.reserved_at IS NOT OLD.reserved_at
BEGIN SELECT RAISE(ABORT, 'closed budget ledger rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ai_budget_ledger_no_delete BEFORE DELETE ON ai_budget_ledger
BEGIN SELECT RAISE(ABORT, 'budget ledger rows cannot be deleted'); END;
`;

// Schema v18 (2 Nov 2026): the same ledger also records Copilot explanations (purpose COPILOT_ANSWER), so the
// Copilot shares the existing daily / total limits instead of getting a second budget. SQLite cannot alter a CHECK,
// so the table is rebuilt under its name: every existing row is copied column for column (copilot_request_id NULL),
// the triggers and indexes are re-created, and the close-once trigger now also freezes copilot_request_id.
// A QUOTE_EXTRACTION row never names a request; a COPILOT_ANSWER row names the request it explained and no run.
// Nothing is back-filled: no Copilot call has ever been made, and old rows get no new purpose or owner.
export const BUDGET_LEDGER_V18_TABLE = `
CREATE TABLE ai_budget_ledger_v18 (
  id                   TEXT PRIMARY KEY CHECK (id GLOB 'abl_*'),
  request_key          TEXT NOT NULL UNIQUE CHECK (length(request_key) BETWEEN 1 AND 200),
  purpose              TEXT NOT NULL CHECK (purpose IN ('QUOTE_EXTRACTION', 'COPILOT_ANSWER')),
  extraction_id        TEXT REFERENCES quote_extraction_runs(id),
  attempt              INTEGER NOT NULL CHECK (typeof(attempt) = 'integer' AND attempt >= 1),
  provider             TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 50),
  model                TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  currency             TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  reserved_micros      INTEGER NOT NULL CHECK (typeof(reserved_micros) = 'integer' AND reserved_micros >= 0),
  input_tokens_bound   INTEGER NOT NULL CHECK (typeof(input_tokens_bound) = 'integer' AND input_tokens_bound >= 0),
  output_tokens_bound  INTEGER NOT NULL CHECK (typeof(output_tokens_bound) = 'integer' AND output_tokens_bound >= 0),
  price_basis          TEXT NOT NULL CHECK (json_valid(price_basis)),
  state                TEXT NOT NULL CHECK (state IN ('RESERVED', 'SETTLED', 'RELEASED', 'UNKNOWN')),
  input_tokens         INTEGER CHECK (input_tokens IS NULL OR (typeof(input_tokens) = 'integer' AND input_tokens >= 0)),
  output_tokens        INTEGER CHECK (output_tokens IS NULL OR (typeof(output_tokens) = 'integer' AND output_tokens >= 0)),
  settled_micros       INTEGER CHECK (settled_micros IS NULL OR (typeof(settled_micros) = 'integer' AND settled_micros >= 0)),
  outcome_note         TEXT CHECK (outcome_note IS NULL OR length(outcome_note) BETWEEN 1 AND 500),
  budget_day           TEXT NOT NULL CHECK (budget_day GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  reserved_at          TEXT NOT NULL,
  closed_at            TEXT,
  copilot_request_id   TEXT REFERENCES procurement_requests(id),
  CHECK ((state = 'RESERVED') = (closed_at IS NULL)),
  CHECK ((state = 'SETTLED') = (settled_micros IS NOT NULL)),
  CHECK ((purpose = 'QUOTE_EXTRACTION' AND copilot_request_id IS NULL)
      OR (purpose = 'COPILOT_ANSWER' AND extraction_id IS NULL AND copilot_request_id IS NOT NULL))
);
INSERT INTO ai_budget_ledger_v18
  (id, request_key, purpose, extraction_id, attempt, provider, model, currency, reserved_micros, input_tokens_bound,
   output_tokens_bound, price_basis, state, input_tokens, output_tokens, settled_micros, outcome_note, budget_day,
   reserved_at, closed_at, copilot_request_id)
SELECT id, request_key, purpose, extraction_id, attempt, provider, model, currency, reserved_micros, input_tokens_bound,
       output_tokens_bound, price_basis, state, input_tokens, output_tokens, settled_micros, outcome_note, budget_day,
       reserved_at, closed_at, NULL
  FROM ai_budget_ledger ORDER BY rowid;
DROP TRIGGER IF EXISTS ai_budget_ledger_close_once;
DROP TRIGGER IF EXISTS ai_budget_ledger_no_delete;
DROP INDEX IF EXISTS ai_budget_ledger_day;
DROP INDEX IF EXISTS ai_budget_ledger_state;
DROP TABLE ai_budget_ledger;
ALTER TABLE ai_budget_ledger_v18 RENAME TO ai_budget_ledger;
`;

export const BUDGET_LEDGER_V18_OBJECTS = `
CREATE INDEX IF NOT EXISTS ai_budget_ledger_day ON ai_budget_ledger(budget_day);
CREATE INDEX IF NOT EXISTS ai_budget_ledger_state ON ai_budget_ledger(state, reserved_at);
CREATE INDEX IF NOT EXISTS ai_budget_ledger_copilot ON ai_budget_ledger(copilot_request_id) WHERE copilot_request_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS ai_budget_ledger_close_once
BEFORE UPDATE ON ai_budget_ledger
WHEN OLD.state <> 'RESERVED'
  OR NEW.id IS NOT OLD.id OR NEW.request_key IS NOT OLD.request_key OR NEW.purpose IS NOT OLD.purpose
  OR NEW.extraction_id IS NOT OLD.extraction_id OR NEW.attempt IS NOT OLD.attempt
  OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.currency IS NOT OLD.currency
  OR NEW.reserved_micros IS NOT OLD.reserved_micros OR NEW.input_tokens_bound IS NOT OLD.input_tokens_bound
  OR NEW.output_tokens_bound IS NOT OLD.output_tokens_bound OR NEW.price_basis IS NOT OLD.price_basis
  OR NEW.budget_day IS NOT OLD.budget_day OR NEW.reserved_at IS NOT OLD.reserved_at
  OR NEW.copilot_request_id IS NOT OLD.copilot_request_id
BEGIN SELECT RAISE(ABORT, 'closed budget ledger rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ai_budget_ledger_no_delete BEFORE DELETE ON ai_budget_ledger
BEGIN SELECT RAISE(ABORT, 'budget ledger rows cannot be deleted'); END;
`;
