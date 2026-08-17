CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  repository TEXT NOT NULL,
  commit TEXT NOT NULL,
  local_modification INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  autoevo_version TEXT NOT NULL,
  dsh_version TEXT,
  stage TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  security_risk TEXT NOT NULL,
  repairability TEXT,
  evolution_value TEXT,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS observations_repository ON observations (repository);
CREATE INDEX IF NOT EXISTS observations_created_at ON observations (created_at);
