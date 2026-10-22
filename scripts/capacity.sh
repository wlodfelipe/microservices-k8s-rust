#!/usr/bin/env bash
# Teste de capacidade de 4 minutos com N pessoas simultâneas (padrão 1000).
#
#   ./scripts/capacity.sh 1000
#   ./scripts/capacity.sh 2000
#   THINK_MIN=0.5 THINK_MAX=1.5 ./scripts/capacity.sh 600   # mesma taxa com menos VUs
#   LIVE=1 ./scripts/capacity.sh 2000      # quem lê um artigo fica com o WebSocket ao vivo aberto
#
# O k6 roda na sua máquina, FORA do orçamento de CPU/RAM do cluster (o gerador de carga
# não compete com a aplicação), mas dentro da rede do minikube: fala direto com o
# NodePort 30080, sem túnel no meio (o túnel do `minikube service` vira gargalo com
# milhares de conexões). Com o driver podman rootless, a rede do minikube só existe
# dentro do namespace de rede do podman, daí o `podman unshare --rootless-netns`.
set -euo pipefail
cd "$(dirname "$0")/.."
USERS="${1:-1000}"
PROFILE="${PROFILE:-socialclone}"
IP="$(minikube -p "$PROFILE" ip)"
NAME="capacidade-${USERS}${THINK_MIN:+-think${THINK_MIN}-${THINK_MAX}}${LIVE:+-live}"
OUT="docs/evidencias/${NAME}.txt"

# O k6 gasta ~0,3–0,5 MB por VU; com GOGC menor o Go devolve memória mais cedo.
export GOGC="${GOGC:-50}"
RUN=(k6 run -e BASE_URL="http://$IP:30080" -e USERS="$USERS" -e LIVE="${LIVE:-}" --summary-export "docs/evidencias/${NAME}.json" deploy/k8s/k6/capacity.js)
# Linha do tempo do HPA: réplicas e CPU de cada serviço a cada 10 s, durante o teste e por
# mais AFTER segundos depois dele (para registrar a volta ao mínimo).
AFTER="${AFTER:-300}"
HPA_OUT="docs/evidencias/${NAME}-hpa.txt"
record_hpa() {
  while :; do
    kubectl -n socialclone get hpa --no-headers 2>/dev/null \
      | awk -v t="$(date +%H:%M:%S)" '{ printf "%s %-9s pods=%s cpu=%s\n", t, $1, $(NF-1), $4 }'
    sleep 10
  done
}
record_hpa > "$HPA_OUT" &
REC=$!
trap 'kill $REC 2>/dev/null || true' EXIT

# k6 abre uma conexão por VU: sobe o limite de arquivos abertos.
ulimit -n 65535 2>/dev/null || true
if [[ "$(minikube -p "$PROFILE" profile list -o json 2>/dev/null | grep -o '"Driver":"[a-z]*"' | head -1)" == *podman* ]] \
   && [[ "$(id -u)" != 0 ]]; then
  podman unshare --rootless-netns "${RUN[@]}" 2>&1 | tee "$OUT"
else
  "${RUN[@]}" 2>&1 | tee "$OUT"
fi
echo "resumo salvo em $OUT"
echo "registrando a volta ao mínimo por mais ${AFTER}s em $HPA_OUT (Ctrl+C para parar)"
sleep "$AFTER"
