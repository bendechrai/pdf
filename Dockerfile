# Production image: build the SPA with Vite, then serve dist/ via nginx.
FROM node:22-slim AS build
WORKDIR /app

COPY webapp/package.json webapp/package-lock.json* ./
RUN npm ci

COPY webapp/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# Railway (and many PaaS) inject PORT. nginx:alpine envsubst-processes
# /etc/nginx/templates/*.template into /etc/nginx/conf.d/ on container start.
ENV PORT=8080
EXPOSE 8080
