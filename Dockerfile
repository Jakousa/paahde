FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
RUN npm run check && npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/dadajam.db
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared shared
COPY server server
COPY --from=build /app/dist dist
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.ts"]
