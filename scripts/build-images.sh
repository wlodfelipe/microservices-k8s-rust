#!/usr/bin/env bash
# Constrói todas as imagens (cada serviço em v1, v2 e v3) e carrega no minikube.
#
#   ./scripts/build-images.sh              # tudo
#   ./scripts/build-images.sh users web    # só alguns serviços
#
# v1 e v2: mesmo código, versões diferentes (para demonstrar rolling update).
# v3: versão "com defeito" (readiness nunca passa), para demonstrar rollout travado.
set -euo pipefail
cd "$(dirname "$0")/.."

ENGINE="${ENGINE:-$(command -v podman >/dev/null && echo podman || echo docker)}"
PROFILE="${PROFILE:-socialclone}"
RUST_SERVICES=(users articles comments gateway ops)
ALL=("${RUST_SERVICES[@]}" web)
TARGETS=("${@:-${ALL[@]}}")
VERSIONS=(v1 v2 v3)
IMAGES=()

for svc in "${TARGETS[@]}"; do
  for v in "${VERSIONS[@]}"; do
    [[ "$svc" == "ops" && "$v" != "v1" ]] && continue   # o painel de controle não troca de versão
    broken=false; [[ "$v" == "v3" ]] && broken=true
    tag="localhost/socialclone/$svc:$v"
    echo "==> $tag"
    if [[ "$svc" == "web" ]]; then
      $ENGINE build -q -f deploy/docker/web.Dockerfile --build-arg APP_VERSION="$v" --build-arg APP_BROKEN="$broken" -t "$tag" web >/dev/null
    else
      $ENGINE build -q -f deploy/docker/rust.Dockerfile --build-arg SERVICE="$svc" --build-arg APP_VERSION="$v" --build-arg APP_BROKEN="$broken" -t "$tag" . >/dev/null
    fi
    IMAGES+=("$tag")
  done
done

echo "==> carregando ${#IMAGES[@]} imagens no minikube ($PROFILE)"
TAR="$(mktemp -d)/images.tar"
if [[ "$ENGINE" == "podman" ]]; then
  podman save -q --multi-image-archive -o "$TAR" "${IMAGES[@]}"
else
  docker save -o "$TAR" "${IMAGES[@]}"
fi
minikube -p "$PROFILE" image load "$TAR" >/dev/null 2>&1
rm -rf "$(dirname "$TAR")"
minikube -p "$PROFILE" image ls | grep socialclone | sort
