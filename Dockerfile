FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY src/ ./src/

RUN npm ci && npm run build

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/
COPY public/ ./public/

RUN mkdir -p /data

EXPOSE 10000

ENV HOST=0.0.0.0
ENV PORT=10000
ENV DB_PATH=/data/chatbot.db

CMD ["node", "dist/index.js"]
