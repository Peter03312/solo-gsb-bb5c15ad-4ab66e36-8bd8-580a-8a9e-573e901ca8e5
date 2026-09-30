# 社团章程修订 Web 应用
FROM node:20-bookworm-slim

# better-sqlite3 在多数平台有预编译二进制；保留构建工具链以备在无预编译包的平台上源码编译
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 复制应用代码与静态资源
COPY src ./src
COPY public ./public

# SQLite 数据库存放目录（由卷持久化）；首次启动自动建表初始化
RUN mkdir -p /data && chown node:node /data
ENV DB_PATH=/data/charter.db \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000
VOLUME ["/data"]

USER node

CMD ["node", "src/server.js"]
