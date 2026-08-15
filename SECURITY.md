# Security Policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/bygama/hud/security/advisories/new).
Do not open public issues for security problems.

You can expect an acknowledgment within a week. Please include reproduction
steps when possible.

## Scope

Supported: the `main` branch. Note this script reads
`~/.claude/.credentials.json` locally to query the usage API — it never
transmits the token anywhere except `api.anthropic.com`.
