# Front-end: build do React com Node e entrega com nginx (não-root, porta 8080).
FROM docker.io/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM docker.io/nginxinc/nginx-unprivileged:1.27-alpine
ARG APP_VERSION=v1
ARG APP_BROKEN=false
# O server{} vira template: o entrypoint substitui ${GATEWAY_UPSTREAM}, ${OPS_URL} e
# ${NGINX_LOCAL_RESOLVERS} no boot.
COPY nginx.main.conf /etc/nginx/nginx.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
USER root
# A versão do front fica em /version.json (o site mostra no rodapé e avisa quando muda).
# v3 cria o arquivo BROKEN, que faz a readiness (/ready) falhar.
RUN printf '{"version":"%s"}\n' "$APP_VERSION" > /usr/share/nginx/html/version.json \
 && if [ "$APP_BROKEN" = "true" ]; then touch /usr/share/nginx/html/BROKEN; fi
USER 101
EXPOSE 8080
