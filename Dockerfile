FROM node:22.23.1-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.28.0-alpine

COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/security-headers.conf /etc/nginx/security-headers.conf
COPY docker/40-validate-api-url.sh /docker-entrypoint.d/40-validate-api-url.sh
RUN chmod 755 /docker-entrypoint.d/40-validate-api-url.sh
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
