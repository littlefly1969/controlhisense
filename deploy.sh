#!/usr/bin/env bash
# Aggiornamento sicuro di un clone (es. server di produzione) alla cronologia
# pubblicata su origin/main.
#
# Usa `git fetch` + `git reset`, MAI `git pull`: percio' funziona anche dopo una
# riscrittura della cronologia (force-push) senza errori di "divergent branches".
#
# I file ignorati da Git (config.json, timers.json, report.json, .venv/, ...) NON
# vengono toccati: il reset agisce solo sui file tracciati.
#
# Uso:
#   ./deploy.sh                  allinea a origin/main (si ferma se ci sono modifiche locali)
#   ./deploy.sh --force          scarta modifiche/commit locali e allinea comunque
#   ./deploy.sh --service clima  dopo l'aggiornamento riavvia il servizio systemd "clima"
#   ./deploy.sh --branch main    usa un branch diverso da main
set -euo pipefail

BRANCH="main"
FORCE=0
SERVICE=""

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --service) SERVICE="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-main}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argomento sconosciuto: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# spostati nella cartella dello script (radice del repo)
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  echo "Errore: questa cartella non e' un repository Git." >&2; exit 1; }

echo "==> Fetch da origin..."
git fetch --prune origin
git rev-parse --verify -q "origin/$BRANCH" >/dev/null || {
  echo "Errore: origin/$BRANCH non esiste." >&2; exit 1; }

# 1) modifiche locali a file TRACCIATI?
DIRTY=0
git diff --quiet && git diff --cached --quiet || DIRTY=1
# 2) commit locali non presenti su origin/$BRANCH?
AHEAD="$(git rev-list --count "origin/$BRANCH..refs/heads/$BRANCH" 2>/dev/null || echo 0)"

if [ "$DIRTY" -eq 1 ]; then
  echo "ATTENZIONE: modifiche locali a file tracciati:" >&2
  git status --short --untracked-files=no >&2
fi
if [ "$AHEAD" -gt 0 ]; then
  echo "ATTENZIONE: $AHEAD commit locali non presenti su origin/$BRANCH:" >&2
  git --no-pager log --oneline "origin/$BRANCH..refs/heads/$BRANCH" >&2
fi
if { [ "$DIRTY" -eq 1 ] || [ "$AHEAD" -gt 0 ]; } && [ "$FORCE" -ne 1 ]; then
  echo "Niente fatto. Salva il lavoro locale oppure rilancia con --force per scartarlo." >&2
  exit 1
fi

OLD="$(git rev-parse --short HEAD 2>/dev/null || echo '-')"
echo "==> Allineo $BRANCH a origin/$BRANCH (config.json e file ignorati restano intatti)..."
git checkout -f -B "$BRANCH" "origin/$BRANCH"
NEW="$(git rev-parse --short HEAD)"
echo "==> Aggiornato: $OLD -> $NEW"
git --no-pager log --oneline -3

[ -f config.json ] || echo "NOTA: config.json assente qui: l'app userebbe i DEFAULT placeholder." >&2

if [ -n "$SERVICE" ]; then
  echo "==> Riavvio servizio systemd: $SERVICE"
  sudo systemctl restart "$SERVICE"
  sudo systemctl --no-pager --lines=0 status "$SERVICE" || true
fi

echo "==> Fatto."
