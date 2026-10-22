# Uma única etapa de build compila o workspace inteiro (os 5 binários dividem as mesmas
# dependências, então compilar junto é bem mais rápido). Cada imagem final copia só o seu
# binário para uma base distroless (~25 MB, sem shell, roda como usuário não-root).
#
#   podman build -f deploy/docker/rust.Dockerfile --build-arg SERVICE=users \
#                --build-arg APP_VERSION=v2 -t socialclone/users:v2 .

FROM docker.io/library/rust:1-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
# Cache do registry e do target entre builds (BuildKit/Buildah).
# O `touch` força o cargo a recompilar as crates do projeto (só elas; as dependências seguem
# em cache). Sem ele, um arquivo editado *durante* um build anterior fica com data mais
# antiga que o artefato no cache, e o cargo, que compara datas, reaproveitaria o binário velho.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    find crates -type f -exec touch {} + \
 && cargo build --release --workspace --locked \
 && mkdir -p /out \
 && cp target/release/users target/release/articles target/release/comments \
       target/release/gateway target/release/ops /out/

# Identificação da versão num arquivo (lido pelo binário no boot). Um RUN, e não um ENV,
# porque o cache do buildah/podman ignora o valor do ARG em instruções ENV.
# v1/v2 têm o mesmo código e mudam só a identificação (fica visível em /info, nos headers
# e no monitor). v3 é a versão com defeito: a readiness nunca passa, para mostrar que o
# Kubernetes segura um rollout quebrado.
FROM build AS info
ARG APP_VERSION=v1
ARG APP_BROKEN=false
RUN printf 'APP_VERSION=%s\nAPP_BROKEN=%s\n' "$APP_VERSION" "$APP_BROKEN" > /out/build-info

FROM gcr.io/distroless/cc-debian12:nonroot
ARG SERVICE
ENV LOG_FORMAT=json PORT=8080
COPY --from=build /out/${SERVICE} /app/service
COPY --from=info /out/build-info /app/build-info
EXPOSE 8080
# UID numérico do usuário "nonroot" da distroless (o Kubernetes exige número para runAsNonRoot)
USER 65532:65532
ENTRYPOINT ["/app/service"]
