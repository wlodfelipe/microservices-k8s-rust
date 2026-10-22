#!/usr/bin/env bash
# Salva em docs/evidencias/ a saída dos comandos pedidos na apresentação.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=docs/evidencias; mkdir -p $OUT
NS=socialclone
run() { echo "\$ $*"; "$@"; echo; }
{
  run kubectl get nodes -o wide
  run kubectl -n $NS get pods -o wide
  run kubectl -n $NS get services
  run kubectl -n $NS get deployments -o wide
  run kubectl -n $NS get hpa,pdb,resourcequota,limitrange
  run kubectl -n $NS get configmaps,secrets
  run kubectl -n $NS top pods
} > $OUT/kubectl.txt 2>&1

# Recriação automática: apaga um pod e mostra o substituto.
POD=$(kubectl -n $NS get pods -l app=articles -o jsonpath='{.items[0].metadata.name}')
{
  echo "\$ kubectl -n $NS delete pod $POD"
  kubectl -n $NS delete pod "$POD" --wait=false
  sleep 6
  echo; echo "\$ kubectl -n $NS get pods -l app=articles   (6 s depois)"
  kubectl -n $NS get pods -l app=articles
} > $OUT/recriacao-de-pod.txt 2>&1
echo "salvo em $OUT/"
