#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec >"$project_root/record.log" 2>&1
cd "$project_root/server"
exec go run ./cmd/arena-server
