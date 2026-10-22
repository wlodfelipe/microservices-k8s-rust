#!/usr/bin/env bash
# Cria (ou liga) o cluster minikube com um orçamento FIXO de recursos.
#
#   ./scripts/cluster-up.sh                     # padrão: 4 CPUs, 6 GiB
#   CPUS=2 MEMORY_MB=3072 ./scripts/cluster-up.sh   # simular uma máquina menor
#
# Dois níveis de isolamento:
#  1. O nó do minikube é um container: o cgroup dele limita CPU e memória de verdade
#     (a aplicação inteira roda dentro desse teto, não com o recurso livre da máquina).
#  2. O kubelet recebe `system-reserved` para que o "allocatable" do nó bata com esse teto.
#     Assim o scheduler, o HPA e o Monitor enxergam 4 CPUs (e não as N CPUs da máquina).
# Dentro do cluster ainda existe o ResourceQuota do namespace (deploy/k8s/00-namespace.yaml)
# e os requests/limits de cada container.
#
# Pode rodar de novo com outros valores: o script reaplica os limites no cluster existente.
set -euo pipefail

PROFILE="${PROFILE:-socialclone}"
CPUS="${CPUS:-4}"
MEMORY_MB="${MEMORY_MB:-6144}"
DRIVER="${DRIVER:-$(command -v podman >/dev/null && echo podman || echo docker)}"

HOST_CPUS=$(nproc)
HOST_MEM_MB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
# O kubelet dentro do container enxerga a máquina inteira; reservamos a diferença
# (deixando ~512 MiB do container para o próprio Kubernetes).
RES_CPU=$(( HOST_CPUS > CPUS ? HOST_CPUS - CPUS : 0 ))
RES_MEM=$(( HOST_MEM_MB - MEMORY_MB + 512 ))
(( RES_MEM < 0 )) && RES_MEM=0

extra=(--extra-config="kubelet.system-reserved=cpu=${RES_CPU},memory=${RES_MEM}Mi")
if [[ "$DRIVER" == "podman" ]]; then
  minikube config set rootless true >/dev/null
  extra+=(--container-runtime=containerd)
fi

minikube start -p "$PROFILE" --driver="$DRIVER" --cpus="$CPUS" --memory="${MEMORY_MB}m" "${extra[@]}"

# Com podman rootless o minikube não aplica --cpus no container do nó: aplicamos aqui.
if [[ "$DRIVER" == "podman" ]]; then
  podman update --cpus "$CPUS" --memory "${MEMORY_MB}m" "$PROFILE" >/dev/null
elif [[ "$DRIVER" == "docker" ]]; then
  docker update --cpus "$CPUS" --memory "${MEMORY_MB}m" "$PROFILE" >/dev/null || true
fi
# Garante que o kubelet leu o system-reserved (num cluster já existente ele precisa reiniciar).
minikube -p "$PROFILE" ssh -- sudo systemctl restart kubelet >/dev/null 2>&1 || true

minikube -p "$PROFILE" addons enable metrics-server >/dev/null
kubectl config use-context "$PROFILE" >/dev/null
for _ in $(seq 1 30); do
  kubectl get nodes >/dev/null 2>&1 && break; sleep 2
done
# O addon mede a CPU dos pods uma vez por minuto: o HPA decide com dados de até 60 s atrás
# e pods novos ficam ~1 min sem métrica. Com 15 s ele reage no ritmo do `behavior` dos HPAs.
kubectl -n kube-system get deploy metrics-server -o json \
  | sed 's/--metric-resolution=[0-9]*s/--metric-resolution=15s/' \
  | kubectl apply -f - >/dev/null 2>&1 || true
echo
echo "Nó: $(kubectl get node "$PROFILE" -o jsonpath='{.status.allocatable.cpu}') CPUs, $(kubectl get node "$PROFILE" -o jsonpath='{.status.allocatable.memory}') alocáveis"
kubectl get nodes -o wide
