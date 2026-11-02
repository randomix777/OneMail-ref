# OneMail on a VPS (Docker Compose)

替代 Cloudflare Workers 的部署方式。Workers 方案实测每次请求冷启动 7–13 秒、
队列消费者 `exceededMemory`，因为单文件 bundle 已达 64.58 MB。这里用一台常驻
Docker 主机跑完整的 Node 运行时，JYI 的 Firebase 登录流程完全不变。

```
浏览器 ──HTTPS──> Cloudflare ──Tunnel──> cloudflared ──> web (Next.js :3000)
                                                        ├── db   (postgres:16)
                                                        ├── redis:7 + serverless-redis-http
                                                        ├── worker (BullMQ, queue-worker profile)
                                                        └── cron   (curl 定时任务)
```

域名保持 `onemail.jyisolutions.com`，因此 JYI 账号中心里注册的回调地址
`https://onemail.jyisolutions.com/api/auth/firebase/callback` 不需要任何改动。

本目录只放"额外"的物料；compose 主文件用仓库根目录的 `docker-compose.yml`
（官方维护，含 `db` / `redis` / `web` / `worker` / `cron` 与 profile）。

---

## 0. 前置条件

| 需要 | 说明 |
|---|---|
| Oracle Cloud 账号 | Always Free 需要信用卡验证，不扣费 |
| Cloudflare 账号 | `jyisolutions.com` 已托管在此 |
| 本仓库 | 用来取 `docker-compose.yml`，或直接在 VM 上 `git clone` |

资源占用参考：web ≈ 0.6–1.5 GB，worker ≈ 150 MB，redis ≈ 50 MB，
postgres ≈ 200 MB。Always Free 的 2 OCPU / 12 GB 有很大余量。

---

## 1. 创建 Oracle Always Free 实例

控制台 → Compute → Instances → Create instance：

- **Image**: Ubuntu 24.04 (aarch64)
- **Shape**: `VM.Standard.A1.Flex`，**2 OCPU / 12 GB**
  （2026-06 起免费额度从 4/24 降为 2/12）
- **Boot volume**: 47–100 GB（免费额度内）
- **Networking**: 默认 VCN，public subnet，**Assign a public IPv4 address**
- 保存 SSH 私钥

> 如果提示 *Out of host capacity*：换一个可用域（Availability Domain）或换个
> 区域重试；ARM 免费额度在热门区域经常排队。加拿大可选 Toronto / Montreal。

安全列表（Security List）只需要 **22/tcp**（来源填你自己的 IP）。
用 Cloudflare Tunnel 时**不需要**开放 80/443。

```bash
ssh -i ~/.ssh/onemail.key ubuntu@<public-ip>
```

---

## 2. 安装 Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"   # 重新登录后生效
```

镜像 `ghcr.io/randomix777/one-mail:latest` 是 `linux/amd64 + linux/arm64`
多架构的，ARM 机器直接 `docker pull` 即可，不需要自己编译。

---

## 3. 准备部署目录

VM 上只需要一个目录：`/opt/onemail`。在**本地仓库根目录**执行：

```bash
ssh -i ~/.ssh/onemail.key ubuntu@<public-ip> \
  'sudo mkdir -p /opt/onemail && sudo chown $USER /opt/onemail'

scp -i ~/.ssh/onemail.key \
  docker-compose.yml \
  deploy/vps/docker-compose.vps.yml \
  deploy/vps/docker-compose.tunnel.yml \
  deploy/vps/up.sh \
  deploy/vps/verify.sh \
  deploy/vps/.env \
  ubuntu@<public-ip>:/opt/onemail/
```

目录里最终是：

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 仓库根目录的官方 compose（db/redis/web/worker/cron） |
| `docker-compose.vps.yml` | 修正镜像名（见下方说明） |
| `docker-compose.tunnel.yml` | 可选，Cloudflare Tunnel |
| `up.sh` | 启动/更新封装，自动判断是否加 Tunnel |
| `verify.sh` | 冒烟测试：健康检查 + JYI 登录跳转 |
| `.env` | 本机生成的完整配置（含随机 secret） |

> **为什么需要 `docker-compose.vps.yml`**：仓库 compose 里写的是
> `ghcr.io/randomix777/OneMail-ref:latest`，但 Docker 的引用语法要求仓库名全小写，
> 直接 pull 会报 `repository name must be lowercase`；CI 实际发布的名字是
> `ghcr.io/randomix777/one-mail`（`linux/amd64` + `linux/arm64`）。
> override 文件把 `web` / `worker` 的镜像都改成了后者。

### 镜像从哪来（重要）

`ghcr.io/randomix777/one-mail:latest` 只包含 **已推送到 main 的代码**。当前
Firebase 登录相关改动还没提交，直接 pull 到的镜像里**没有**新的
`/api/auth/firebase/*` 路由。二选一：

**A. 先提交推送，让 CI 构建（推荐）**

```bash
git push origin main
# GitHub Actions "Build Inbox Zero Docker Image" 跑完（约 20–30 分钟）
```

之后 VM 上 `./up.sh --pull` 拉到的就是含新登录流程的多架构镜像。

**B. 直接在这台 VM 上从源码构建**

把工作区同步到 VM（含未提交改动），然后本地出镜像：

```bash
# 本地仓库根目录
rsync -az --exclude node_modules --exclude .next --exclude .open-next \
  --exclude '.env*' --exclude .git \
  -e "ssh -i ~/.ssh/onemail.key" ./ ubuntu@<public-ip>:/opt/onemail/src/

# VM 上（ARM 原生构建，2 OCPU 约 25–40 分钟）
cd /opt/onemail/src
docker build -f docker/Dockerfile.prod -t onemail:local .
```

然后在 `/opt/onemail/.env` 里加一行，让 compose 用这个镜像：

```bash
ONEMAIL_IMAGE=onemail:local
```

**私有包的访问**：`ghcr.io/randomix777/one-mail` 目前是私有包，走方案 A 时需
先登录（二选一）：

```bash
# 方式 1：GitHub PAT（classic，勾 read:packages）登录一次
echo "<YOUR_GHCR_PAT>" | docker login ghcr.io -u <github-username> --password-stdin

# 方式 2（更省事）：GitHub → 仓库 → Packages → one-mail → Package settings
#   → Change visibility → Public，之后无需登录
```

登录凭据会保存在 `~/.docker/config.json`，重启后仍有效。方案 B 不涉及仓库。

`.env` 已经在本地生成好了：**`deploy/vps/.env`**（被 `.gitignore` 的 `.env*`
规则忽略，不会进仓库，上面的 `scp` 已经包含它）。里面已包含随机生成的数据库
密码、AUTH/加密/CRON 等全部 secret，以及和 JYI Worker 一致的
`FIREBASE_CLIENT_SECRET_ONEMAIL`。

只剩一项需要你手工填：**`TUNNEL_TOKEN`**（方案 A 才需要，见第 5 步）。

> 数据库是**全新的空库**：现阶段 Supabase 上那 302 条 migration 只有表结构、
> 没有业务数据，所以不需要迁移任何内容，也就不用去碰 Supabase 的密码。

如果要重新生成一份（例如换环境）：

```bash
cp .env.example .env
node -e '
const c=require("crypto");const h=n=>c.randomBytes(n).toString("hex");
for (const [k,n] of [["AUTH_SECRET",32],["EMAIL_ENCRYPT_SECRET",32],["EMAIL_ENCRYPT_SALT",16],
  ["API_KEY_SALT",32],["INTERNAL_API_KEY",32],["CRON_SECRET",32],["HEALTH_API_KEY",32],
  ["REDIS_HTTP_TOKEN",32]]) console.log(`${k}=${h(n)}`);
' >> .env   # 再手工改掉 POSTGRES_PASSWORD / DATABASE_URL / DIRECT_URL
```

无论用哪种方式，都要确认：

1. `POSTGRES_PASSWORD` 与 `DATABASE_URL` / `DIRECT_URL` 里的密码部分一致；
2. `FIREBASE_CLIENT_SECRET_ONEMAIL` 与 JYI Worker 的 secret
   `FIREBASE_CLIENT_SECRET_ONEMAIL` 完全一致（本地值取自
   `apps/web/.env.production`）；
3. `NEXT_PUBLIC_BASE_URL=https://onemail.jyisolutions.com`。

---

## 4. 启动

```bash
cd /opt/onemail
chmod +x up.sh verify.sh
./up.sh --pull
docker compose logs -f web
```

服务起来后先跑冒烟测试（默认测 `https://onemail.jyisolutions.com`，
也可以传本地地址 `./verify.sh http://127.0.0.1:3000`）：

```bash
./verify.sh http://127.0.0.1:3000
```

首次启动 `start.sh` 会自动执行 `migrate.sh`，把 302 条 Prisma migration
跑到容器内的 Postgres 上，大约 1–3 分钟。看到 `Starting server...` 后即可。

> 迁移失败时 `start.sh` 仍会继续启动（只打警告），所以务必确认日志里出现过
> `✅ Database migrations completed successfully`。超时上限已通过
> `MIGRATION_TIMEOUT_SECONDS=900` 放宽。

健康检查：

```bash
curl -s http://127.0.0.1:3000/api/health
# {"status":"ok"}

# 带 key 的深检（同时验证数据库）
. ./.env
curl -s -H "x-health-api-key: $HEALTH_API_KEY" http://127.0.0.1:3000/api/health
# {"status":"healthy", ..., "database":{"status":"healthy"}}
```

此时应用已经在跑，但公网还访问不到。

---

## 5. 暴露到公网

### 方案 A（推荐）：Cloudflare Tunnel

不需要公网 IP、不需要开 80/443、不需要证书。

1. Zero Trust 控制台 → Networks → Tunnels → **Create a tunnel** → Cloudflared →
   复制 token；
2. 写进 `.env` 的 `TUNNEL_TOKEN=`；
3. 重新启动（`up.sh` 检测到 token 会自动加上 tunnel override）：
   ```bash
   cd /opt/onemail && ./up.sh
   ```
   > token 留空时 compose 会直接报 `required variable TUNNEL_TOKEN is missing
   > a value`，不会起一个坏容器。
4. 在该 tunnel 的 **Public Hostname** 添加：
   - Subdomain: `onemail`
   - Domain: `jyisolutions.com`
   - Service: `http://web:3000`

### 方案 B：Caddy 直接对外

需要先放开 80/443：

```bash
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

并在 OCI 安全列表放行 80/443，然后按本目录 `Caddyfile` 安装 Caddy，
把 DNS 的 A 记录指向 VM 公网 IP。

---

## 6. 切换 DNS（关键，顺序不能反）

`onemail.jyisolutions.com` 目前绑在 Cloudflare Worker 上，必须先解绑，
Tunnel/Caddy 才能接管：

1. Cloudflare 控制台 → Workers & Pages → `onemail` → Settings →
   Domains & Routes → 删除 `onemail.jyisolutions.com`；
2. 立刻在 Tunnel 里添加 Public Hostname（方案 A 会自动建 CNAME），
   或把 A 记录改到 VM（方案 B）；
3. 验证：
   ```bash
   curl -sI https://onemail.jyisolutions.com/api/health | head -1
   curl -s "https://onemail.jyisolutions.com/api/auth/firebase/start?callbackURL=%2Fwelcome-redirect" -o /dev/null -w "%{http_code} %{redirect_url}\n"
   ```
   第二条应返回 `302` 且跳转到
   `https://account.jyisolutions.com/firebase-sign-in?...client_id=onemail-web...`。

Worker 可以保留（不绑定域名）作为回退，确认稳定后再删。

---

## 7. 验收清单

- [ ] `./verify.sh` 四项全 `ok`（health / login / start / redirect target）
- [ ] `/api/health` 200，深检 `database.status = healthy`
- [ ] `/login` 跳转到 JYI 账号中心全屏页，显示 "Cancel and return to OneMail"
- [ ] 完成一次真实登录，回到 `/welcome-redirect` 并进入主界面
- [ ] `docker compose logs worker` 无报错，Redis 队列连通
- [ ] `docker compose logs cron` 每 15 分钟有 scheduled-actions / automation-jobs 记录
- [ ] 页面首字节 < 500 ms（不再是 Workers 的 7–13 秒）
- [ ] 重启一次 VM，`docker compose ps` 全部自动拉起

---

## 8. 日常运维

```bash
# 日志
docker compose logs -f web worker cron

# 更新镜像
./up.sh --pull

# 备份（建议加到宿主机 crontab）
docker compose exec -T db pg_dump -U postgres inboxzero | gzip > /opt/backup/onemail-$(date +%F).sql.gz

# 恢复
gunzip -c /opt/backup/onemail-2026-11-01.sql.gz | docker compose exec -T db psql -U postgres inboxzero

# 停止 / 启动（down 不会删数据卷）
docker compose -f docker-compose.yml -f docker-compose.vps.yml --profile all --profile queue-worker down
./up.sh
```

建议把 `/opt/backup` 再同步到 OCI 对象存储（Always Free 20 GB）或任意 S3。

---

## 9. 常见问题

| 现象 | 处理 |
|---|---|
| 启动时报 `P1001: Can't reach database server` | `db` 健康检查还没过；`docker compose logs db`，确认 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 一致 |
| 登录回调 `ticket_rejected` | `FIREBASE_CLIENT_SECRET_ONEMAIL` 与 JYI 侧不一致；两边必须同一个值 |
| 登录回调 `account_unavailable` / `session_unavailable` | 迁移没跑完；`docker compose logs web | grep -i migrate` |
| `502` 来自 Cloudflare | Tunnel 未连上，或 Public Hostname 指向了错误的 service（应为 `http://web:3000`） |
| ARM 机器 `exec format error` | 用了老的单架构镜像；确认 `docker compose pull` 拉到的是 `linux/arm64` |
| 想要 AI 功能 | 在 `.env` 里补 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` 之一，重启 web |
