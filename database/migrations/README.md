# PostgreSQL Migrations

No business tables or migration scripts exist yet. Block, event, match, and round projections are planned for chain indexing.

Future migrations use ordered filenames and document their schema, transaction boundaries, and recovery procedure. Official match data is a canonical-chain projection that can be rebuilt; the database cannot change an authoritative outcome.

Select the migration tool and PostgreSQL image version when database integration begins. This stage does not require installing or starting a database.
