# 安全扫描（初版）— 2026-11-19

范围：整个仓库，基线提交 `d2f308c`（master）。手工代码审阅：`apps/api` 全部路由、认证、数据层、LiveKit 令牌与 webhook、实时转录；`apps/web` 的危险 sink 与凭证处理；部署配置（`Caddyfile`、`docker-compose.yml`、`Dockerfile`、`.env.example`）；`npm audit`；仓库及 git 历史的密钥扫描。

未覆盖：动态渗透测试 / PoC 复现、LiveKit 服务端自身配置的深入审查（TURN 见 I-5）、移动端浏览器行为、`scripts/` 下的一次性 spike / 压测脚本。

严重度是初步判断，供修复排序用，最终以安全组评审为准。

## 汇总

| ID      | 严重度 | 标题                                                                            |
| ------- | ------ | ------------------------------------------------------------------------------- |
| M-1     | 中高   | 任何听众都能看到并冒用同房间其他听众的 connectionId，可把对方踢下线             |
| M-2     | 中     | 没有任何安全响应头（HSTS / CSP / frame-ancestors / nosniff）                    |
| M-3     | 中     | 登录锁定可被外部恶意触发，活动当天能把译员 / 审批员 / admin 锁在门外            |
| M-4     | 中     | 公开听众 API 没有请求体大小和字段长度上限，按主体限流可被绕过 → 磁盘 / 内存 DoS |
| M-5     | 中低   | 译员 / 审批员密码只做单轮 SHA-256；手动设置的译员密码没有长度下限               |
| L-1     | 低     | 修改自己的密码时没有 8 位最小长度校验                                           |
| L-2     | 低     | 维护接口 `backfill-device-labels` 缺少 admin 角色检查                           |
| L-3     | 低     | 译员 LiveKit 令牌没有限制为仅麦克风（可推视频 / 屏幕共享）                      |
| L-4     | 低     | admin 密码 PBKDF2 只有 10 万次迭代                                              |
| L-5     | 低     | 依赖有已知漏洞（生产依赖：hono、@hono/node-server、react-router）               |
| L-6     | 低     | 容器以 root 运行                                                                |
| L-7     | 低     | 任意 `user` 账号可无限制触发 ElevenLabs / Claude 的计费调用                     |
| I-1…I-6 | 信息   | 纵深防御建议（见文末）                                                          |

---

## M-1 听众 connectionId 对同房间所有人可见，且它是唯一凭证（中高）

**位置**：[tokens.ts:79-97](../../apps/api/src/livekit/tokens.ts)、[listeners.ts](../../apps/api/src/routes/listeners.ts)（`/token`、`/leave`、`/heartbeat`、`/connected`、`/switch`、`/reconnect`）

**问题**：

1. 听众令牌的 identity 是 `listener:<connectionId>`，metadata 里也带 `connectionId`，但 grant 没设置 `hidden: true`。LiveKit 会把房间内所有参与者的 identity / metadata 推送给每个订阅者，所以同一语言房间里的任何听众都能拿到其他所有听众的 connectionId。
2. 公开的听众接口只凭 `connectionId`（加上公开的 slug / streamId）鉴权。
3. LiveKit 文档明确写着：identity 在房间内唯一，同 identity 后加入者会把之前的连接**自动断开**。

**利用**：听众 A 进房后，从 `room.remoteParticipants` 读出所有 `listener:<id>`，对每个 id 调 `POST /api/listeners/token` 拿到同 identity 的令牌并加入房间，原听众就被 LiveKit 踢下线。单个 IP 每分钟允许 6000 次 join 类请求，脚本可以持续把整个语言频道的听众都踢掉。开启 access control 的活动里，攻击者需要先有一个已审批的 access token（见 I-3：token 可共享）。另外还可以调 `/leave` 或 `/switch`，篡改别人在管理端报表里的连接记录。

**建议**：

- 听众 grant 加 `hidden: true`（规模上也有好处：数千听众不会互相广播参与者列表）。
- metadata 里去掉 `connectionId`，webhook 改为从 identity 解析。
- 发一个仅创建者持有的 `connectionSecret`（随 `/request` 返回、只存哈希），`/token`、`/leave`、`/switch`、`/reconnect` 都要求带上它。

> 尚未做实际复现，建议修复前先在本地写一个 e2e / 脚本 PoC 确认。

## M-2 没有任何安全响应头（中）

**位置**：[index.ts:83-87](../../apps/api/src/index.ts)（只设置了 `Accept-CH` / `Critical-CH`）、[Caddyfile](../../Caddyfile)

**问题**：应用和 Caddy 都没有设置 `Strict-Transport-Security`、`Content-Security-Policy`（含 `frame-ancestors`）、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`。

**影响**：`/manage`、`/{slug}/approver`、`/{slug}/translate` 可以被第三方页面 iframe 嵌入，构成点击劫持（例如诱导点击“踢下线”、“撤销访问”、“生成新链接”）。也没有 CSP 作为 XSS 的第二道防线。

**建议**：在 Caddy 的两个站点块（或用 Hono 的 `secureHeaders()`）统一加：HSTS（`max-age=31536000`）、`frame-ancestors 'none'`、`nosniff`、`Referrer-Policy: no-referrer`（译员链接的凭证在 fragment 里，fragment 本来就不会进 Referer，这里只是加固）、`Permissions-Policy: camera=(), microphone=(self)`，CSP 先以 report-only 模式上线（需要放行 LiveKit 的 `wss://rtc.<domain>` 和 ElevenLabs 的 WebSocket）。

## M-3 登录锁定可被恶意触发（活动当天 DoS）（中）

**位置**：[loginThrottle.ts:4-9](../../apps/api/src/auth/loginThrottle.ts)、[approverRepository.ts:10-12](../../apps/api/src/db/approverRepository.ts)

| 角色   | 锁定键                 | 阈值                         | 键是否公开                                                      |
| ------ | ---------------------- | ---------------------------- | --------------------------------------------------------------- |
| 译员   | `programId + streamId` | 15 分钟内 10 次 → 锁 15 分钟 | 是：`streamId` 在公开的 `/api/public/programs/{slug}/status` 里 |
| 审批员 | 整个 program           | 5 分钟内 100 次              | 是：slug 印在 QR 上                                             |
| admin  | 用户名                 | 15 分钟内 20 次 → 锁 15 分钟 | 是：固定为 `admin`                                              |

**影响**：攻击者换 IP（或者只发错密码）就能让某个语言的译员在活动中途无法重新登录（例如断线、换设备之后），或者让审批员在入场高峰时登不上去。已有会话不受影响，所以影响限于需要重新登录的场景。

**建议**：用户 / 程序级的桶不要硬锁，改为渐进延迟或 CAPTCHA 类挑战。硬锁只保留在 IP 桶上。译员登录可以考虑只接受随机 token（256 bit，暴力破解不可行），这样可以放宽 streamId 桶。管理端加一个“解锁”操作。

## M-4 公开 API 缺少请求体 / 字段长度上限，限流可绕过（中）

**位置**：[http.ts:38](../../apps/api/src/http.ts)（`request.json()` 无上限）、[listeners.ts](../../apps/api/src/routes/listeners.ts)（`clientId`、`reason`、`streamId` 无长度校验；`user-agent` 和 `sec-ch-*` 头原样入库）、[rateLimiter.ts:93-96](../../apps/api/src/security/rateLimiter.ts)

**问题**：Hono / Node 和 Caddy 都没有 body size 限制。每主体限流以客户端自己选的 `clientId` 为键，换一个 `clientId` 就能绕过，所以实际只剩每 IP 6000 次/分钟的上限。

**利用**：单个 IP 每分钟能往 `listener_connections` / `listener_access` 写约 6000 行带超长字符串的数据（`/request`、`/access/claim`），一天约 860 万行，可以把 VM 磁盘写满，SQLite 也会变慢。大 body 本身也会占用内存。

**建议**：Caddy 加 `request_body { max_size 64KB }`（或用 Hono 的 `bodyLimit`）。所有听众字段做长度和字符集校验（`clientId` ≤ 64、`reason` 使用枚举、UA 截断到 512，和译员登录保持一致）。考虑给每个 program 的待审 claim / 未连接 connection 数设上限。

## M-5 译员 / 审批员凭证哈希偏弱（中低）

**位置**：[translatorRepository.ts:483, 733-735](../../apps/api/src/db/translatorRepository.ts)、[approverRepository.ts:186, 396](../../apps/api/src/db/approverRepository.ts)、[programs.ts:211, 247, 263](../../apps/api/src/domain/programs.ts)

**问题**：

- 哈希是 `sha256(password + pepper)`：没有每行 salt，只做一轮。`.env.example` 里的注释“in addition to its per-row salt”和实际实现不符。
- 译员比较用的是 `!==`，不是恒定时间比较（审批员用了恒定时间比较）。
- 手动设置的译员密码（创建 stream 时的 `translatorPassword`、`reset-password`）只要求非空，可以只有 1 个字符。

**影响**：随机生成的 256 bit token 不受影响。手动设置的弱密码加上 M-3 的阈值，在活动期间有被在线猜中的可能；如果 DB 和 pepper 同时泄露，可以离线快速破解。

**建议**：手动密码统一要求 ≥ 12 位（或者直接取消手动密码，只用生成的链接）；改用 PBKDF2 / scrypt 加每行 salt（复用 `UsersRepository` 的实现）；比较改为 `timingSafeEqual`；修正 `.env.example` 里的注释。

## L-1 修改自己的密码没有最小长度（低）

[adminAuth.ts:239-242](../../apps/api/src/auth/adminAuth.ts) 只检查非空，绕过了 [users.ts:9](../../apps/api/src/domain/users.ts) 的 8 位规则（admin 也能把自己的密码改成 1 位）。另外这个接口验证 `currentPassword` 时没有走登录限流。**建议**：复用 `parsePassword`，并接入限流。

## L-2 维护接口缺少角色检查（低）

[admin.ts:1077-1088](../../apps/api/src/routes/admin.ts)：`POST /api/admin/maintenance/backfill-device-labels` 只要求登录，普通 `user` 账号也能对**所有 program** 的听众数据触发批量回填。数据是确定性派生的，危害有限，但属于越权。**建议**：加 `auth.role === 'admin'` 检查。

## L-3 译员令牌没有限制发布源（低）

[tokens.ts:58-64](../../apps/api/src/livekit/tokens.ts)：`canPublish: true` 但没设 `canPublishSources`。持有译员凭证的人可以向所有听众推送视频或屏幕共享，和“只传语音”的产品原则不符。**建议**：`canPublishSources: [TrackSource.MICROPHONE]`。

## L-4 PBKDF2 迭代次数偏低（低）

[usersRepository.ts:43](../../apps/api/src/db/usersRepository.ts)：10 万次。这是 Workers 时期的限制遗留，代码注释里已经标为待办。OWASP 当前对 PBKDF2-SHA256 的建议约为 60 万次。迭代次数按行存储，可以平滑升级（登录成功时重新哈希）。

## L-5 依赖漏洞（低，需要升级）

`npm audit`：共 20 个（7 high，13 moderate）。只看生产依赖：

- `hono` / `@hono/node-server`（moderate）：`serveStatic` 二次解码、反斜杠路径等。本项目的路由在 `serveStatic` 之前按 `url.pathname` 手工分发，静态目录下也没有受保护的文件，**目前看不可利用**，但建议升级。
- `react-router(-dom)`（high）：RSC 模式下的 CSRF。本项目是纯 SPA，**不适用**。

其余是开发依赖（vite、vitest、eslint、undici 等），只影响本地 dev server。`npm audit fix` 可以修掉大部分；vite 需要升级到 8.3.x。

## L-6 容器以 root 运行（低）

[Dockerfile](../../Dockerfile) 的 runtime 阶段没有 `USER node`。**建议**：加上 `USER node`，并确保 `/data` 卷的属主正确。

## L-7 转录相关的计费调用没有限额（低）

[transcript.ts](../../apps/api/src/routes/transcript.ts)：任何拥有某个 program 的 `user` 账号都能无限调用 `/session`（铸造 ElevenLabs 单次 token）和推送 segment（每条触发每种语言一次 Claude 调用）。另外每个译员会话可以开任意多条 SSE 连接。**建议**：按用户 / program 做简单的速率和并发限制。

---

## 信息 / 纵深防御

- **I-1 CSRF**：目前依赖 `SameSite=Lax` + JSON body，在没有同站点子域被攻破的前提下是安全的。建议对非 GET 的 `/api/*` 加 `Origin` / `Sec-Fetch-Site` 校验，并要求 `Content-Type: application/json`。Cookie 可以改用 `__Host-` 前缀。
- **I-2** `GET /api/public/programs/{slug}/access/approved` 公开返回最近 90 秒内审批通过的 claimId。兑换 token 还需要 claimSecret，所以危害很低，但会暴露审批节奏。如果前端只是用它判断“我是否已被批准”，可以改为客户端带 claimSecret 查询自己的状态（`/access/status` 已经支持）。
- **I-3** 听众 access token 不绑定设备，可以无限共享（一个人被审批后，把 token 分享出去，所有人都能进）。如果活动对准入有严格要求，需要在产品层面决定是否绑定 clientId 或限制并发。
- **I-4** LiveKit 未配置时 `/api/livekit/webhook` 仍然开放，会用空 key 构造 `WebhookReceiver`。建议未配置时直接返回 503。
- **I-5** LiveKit 内置 TURN（udp 3478）运行在 host 网络上。请安全组确认 TURN 不能中继到 `127.0.0.1` / `169.254.169.254`（GCP 元数据服务）/ 内网地址。
- **I-6** `/api/admin/transcript/{slug}/…` 遇到非法百分号编码时 `decodeURIComponent` 会抛异常，返回 500（无安全影响）。

## 已确认做得好的地方（便于安全组快速过）

- SQL 全部用参数化查询；动态拼接的部分只有常量列名 / 表名。
- 会话 token 是高熵随机值，库里只存 `sha256(token + secret)`；修改密码、重置密码、生成新译员链接时都会吊销旧会话。
- program 级访问控制是集中的（`requireProgramAccess`），对不存在和无权访问的资源返回一致的 404；子资源查询都带 `program_id` 条件。
- 听众 LiveKit grant 为只订阅（`canPublish: false`、`canPublishData: false`），webhook 有签名校验。
- 译员链接的凭证放在 URL fragment 中，登录后会从地址栏清除。
- CSV 导出防了公式注入；React 端没有 `dangerouslySetInnerHTML` 之类的 sink。
- 部署上：应用只绑定 `127.0.0.1`，LiveKit 信令只绑定 loopback，经 Caddy 统一入口；只信任 Caddy 覆盖过的 `X-Forwarded-For`；启动检查会拒绝占位符或过短的密钥和 dev LiveKit 凭证。
- 仓库和 git 历史中未发现提交过的真实密钥或 `.env` 文件。
