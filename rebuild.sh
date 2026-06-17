#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env.collab"
COMPOSE_FILE="docker-compose.collab.yml"

echo "========================================"
echo " LingFang 协作平台 - 一键构建 & 部署"
echo "========================================"
echo ""

# 1. 停止旧容器
echo "[1/4] 停止旧容器..."
docker compose -f "$COMPOSE_FILE" down 2>/dev/null || true

# 2. 构建镜像（无缓存，确保最新代码）
echo "[2/4] 构建镜像（无缓存）..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build --no-cache collab-api collab-admin
echo "镜像构建完成。"

# 3. 启动服务
echo "[3/4] 启动服务..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

# 4. 等待 API 就绪
echo "[4/4] 等待 API 就绪..."
for i in $(seq 1 30); do
    if curl -sf -o /dev/null http://0.0.0.0:19006/api/health 2>/dev/null; then
        echo "API 就绪！"
        break
    fi
    sleep 2
done

echo ""
echo "========================================"
echo " 部署完成！"
echo "========================================"
docker compose -f "$COMPOSE_FILE" ps
echo ""
echo "管理后台: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<服务器IP>'):19005"
echo "API 后端: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<服务器IP>'):19006"
echo "账号: admin@example.com / ChangeMe123!"
