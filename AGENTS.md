# AGENTS.md

Inventory backbone — one central warehouse feeding 14 branches. Movements are
the truth; on-hand is derived. See `README.md` for setup, gates and rules.

## Agent skills

### Issue tracker

Issues live in GitHub Issues at `adiyab25/warehouse`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
