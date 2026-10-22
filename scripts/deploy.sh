#!/usr/bin/env bash
# Aplica a aplicação no minikube: Secret (senhas aleatórias), manifestos e espera tudo
# ficar pronto. Pode rodar quantas vezes quiser (idempotente).
#
#   ./scripts/cluster-up.sh && ./scripts/build-images.sh && ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="${PROFILE:-socialclone}"
NS=socialclone

kubectl apply -f deploy/k8s/00-namespace.yaml >/dev/null

# Secret criado uma vez só com valores aleatórios (rodar de novo mantém os mesmos).
if ! kubectl -n $NS get secret app-secrets >/dev/null 2>&1; then
  rnd() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
  PG=$(rnd); JWT=$(rnd)$(rnd); U=$(rnd); A=$(rnd); C=$(rnd)
  kubectl -n $NS create secret generic app-secrets \
    --from-literal=POSTGRES_PASSWORD="$PG" \
    --from-literal=JWT_SECRET="$JWT" \
    --from-literal=USERS_DB_PASSWORD="$U" \
    --from-literal=ARTICLES_DB_PASSWORD="$A" \
    --from-literal=COMMENTS_DB_PASSWORD="$C" \
    --from-literal=USERS_DATABASE_URL="postgres://users_svc:$U@postgres:5432/users_db" \
    --from-literal=ARTICLES_DATABASE_URL="postgres://articles_svc:$A@postgres:5432/articles_db" \
    --from-literal=COMMENTS_DATABASE_URL="postgres://comments_svc:$C@postgres:5432/comments_db"
  echo "Secret app-secrets criado"
fi

# RabbitMQ em Secret separado (assim quem já tinha o app-secrets não precisa recriar).
if ! kubectl -n $NS get secret rabbitmq-secrets >/dev/null 2>&1; then
  RQ=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  kubectl -n $NS create secret generic rabbitmq-secrets \
    --from-literal=RABBITMQ_DEFAULT_USER=socialclone \
    --from-literal=RABBITMQ_DEFAULT_PASS="$RQ" \
    --from-literal=AMQP_URL="amqp://socialclone:$RQ@rabbitmq:5672/%2f"
  echo "Secret rabbitmq-secrets criado"
fi

kubectl apply -k deploy/k8s

echo "==> aguardando o banco e o RabbitMQ"
kubectl -n $NS rollout status deploy/postgres --timeout=180s
kubectl -n $NS rollout status deploy/rabbitmq --timeout=180s
echo "==> aguardando os serviços"
for d in users articles comments gateway web ops; do
  kubectl -n $NS rollout status deploy/$d --timeout=180s
done

kubectl -n $NS get pods -o wide
echo
echo "Aplicação no ar. Para abrir no navegador:"
echo "  minikube -p $PROFILE service web -n $NS        (abre um túnel e o navegador)"
echo "  ou: kubectl -n $NS port-forward svc/web 8080:80   → http://localhost:8080"
