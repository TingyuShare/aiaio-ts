FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --omit=dev

# Copy built files
COPY dist/ ./dist/
COPY public/ ./public/

# Create data directory
RUN mkdir -p /data

EXPOSE 10000

ENV HOST=0.0.0.0
ENV PORT=10000
ENV DB_PATH=/data/chatbot.db

CMD ["node", "dist/index.js"]
