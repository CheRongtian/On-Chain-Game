CREATE TABLE IF NOT EXISTS deployments (
    id BIGSERIAL PRIMARY KEY,
    chain_id NUMERIC(78, 0) NOT NULL CHECK (chain_id > 0),
    arena TEXT NOT NULL CHECK (arena ~ '^0x[0-9a-f]{40}$'),
    deployment_block BIGINT NOT NULL CHECK (deployment_block >= 0),
    deployment_hash TEXT NOT NULL,
    UNIQUE (chain_id, arena, deployment_hash)
);

CREATE TABLE IF NOT EXISTS chain_blocks (
    deployment_id BIGINT NOT NULL REFERENCES deployments(id),
    number BIGINT NOT NULL,
    hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    PRIMARY KEY (deployment_id, number),
    UNIQUE (deployment_id, number, hash)
);

CREATE TABLE IF NOT EXISTS chain_events (
    id BIGSERIAL PRIMARY KEY,
    deployment_id BIGINT NOT NULL REFERENCES deployments(id),
    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    tx_index INTEGER NOT NULL,
    log_index INTEGER NOT NULL,
    name TEXT NOT NULL,
    match_id NUMERIC(78, 0) NOT NULL CHECK (match_id > 0),
    round SMALLINT NOT NULL CHECK (round BETWEEN 0 AND 20),
    raw_log JSONB NOT NULL,
    payload JSONB NOT NULL,
    UNIQUE (deployment_id, block_hash, tx_hash, log_index),
    UNIQUE (deployment_id, block_number, log_index),
    FOREIGN KEY (deployment_id, block_number, block_hash)
        REFERENCES chain_blocks(deployment_id, number, hash) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chain_events_match ON chain_events(deployment_id, match_id, block_number, log_index);

CREATE TABLE IF NOT EXISTS matches (
    deployment_id BIGINT NOT NULL REFERENCES deployments(id),
    match_id NUMERIC(78, 0) NOT NULL CHECK (match_id > 0),
    phase SMALLINT NOT NULL CHECK (phase BETWEEN 1 AND 7),
    data JSONB NOT NULL,
    PRIMARY KEY (deployment_id, match_id)
);
CREATE INDEX IF NOT EXISTS matches_phase ON matches(deployment_id, phase, match_id);

CREATE TABLE IF NOT EXISTS rounds (
    deployment_id BIGINT NOT NULL,
    match_id NUMERIC(78, 0) NOT NULL,
    round SMALLINT NOT NULL CHECK (round BETWEEN 1 AND 20),
    phase SMALLINT NOT NULL,
    deadline BIGINT NOT NULL,
    before_hash TEXT,
    after_hash TEXT,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    source_event BIGINT NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
    PRIMARY KEY (deployment_id, match_id, round),
    FOREIGN KEY (deployment_id, match_id) REFERENCES matches(deployment_id, match_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS round_actions (
    deployment_id BIGINT NOT NULL,
    match_id NUMERIC(78, 0) NOT NULL,
    round SMALLINT NOT NULL,
    player TEXT NOT NULL,
    commitment TEXT NOT NULL,
    actions JSONB,
    salt TEXT,
    commit_event BIGINT NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
    reveal_event BIGINT REFERENCES chain_events(id) ON DELETE CASCADE,
    PRIMARY KEY (deployment_id, match_id, round, player),
    FOREIGN KEY (deployment_id, match_id, round) REFERENCES rounds(deployment_id, match_id, round) ON DELETE CASCADE,
    CHECK ((actions IS NULL AND salt IS NULL AND reveal_event IS NULL)
        OR (actions IS NOT NULL AND salt IS NOT NULL AND reveal_event IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS battle_snapshots (
    deployment_id BIGINT NOT NULL,
    match_id NUMERIC(78, 0) NOT NULL,
    round SMALLINT NOT NULL,
    source_event BIGINT NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
    state JSONB NOT NULL,
    state_hash TEXT NOT NULL,
    PRIMARY KEY (deployment_id, match_id, source_event),
    FOREIGN KEY (deployment_id, match_id) REFERENCES matches(deployment_id, match_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_cursors (
    deployment_id BIGINT PRIMARY KEY REFERENCES deployments(id),
    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keeper_attempts (
    id BIGSERIAL PRIMARY KEY,
    deployment_id BIGINT NOT NULL,
    match_id NUMERIC(78, 0) NOT NULL,
    round SMALLINT NOT NULL,
    operation TEXT NOT NULL,
    tx_hash TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (deployment_id, match_id) REFERENCES matches(deployment_id, match_id)
);
