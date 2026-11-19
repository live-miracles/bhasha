# 安全修复执行手册（临时文档）— 2026-11-19

> 给执行修复的 agent 看的。问题的背景、影响和严重度见同目录的
> [2026-11-19-preliminary-scan.md](2026-11-19-preliminary-scan.md)（下面简称“扫描报告”）。
> 本文只写**怎么改、改哪里、怎么验证、什么时候停下来问人**。全部修完、通过安全组评审之后，可以删掉本文件。

基线提交：`d2f308c`（master）。下文给出的行号以这个提交为准，代码有改动后会漂移，请以**函数名和代码片段**为准定位。

---

## 0. 开工前必读（硬性规则）

1. 先读 `AGENTS.md` 和 `README.md`。仓库规则优先于本文。
2. **不要 commit、push、rebase、reset**，除非用户明确要求。每个修复项改完后停下来汇报，让用户决定。
3. **不要打印、复制或写入任何真实密钥**（`.env`、LiveKit、session secret）。只能确认它们存在。
4. 涉及 LiveKit、Hono、Caddy、Docker 的 API 用法，动手前先按 `AGENTS.md` 的方法用 `ctx7` 查当前文档，不要凭记忆写。
5. 每个修复项都要：
    - 改动只限于本文列出的文件。如果需要碰别的文件，先说明理由。
    - 加上或更新对应的测试（本文每项都写了要测什么）。
    - 跑这一项的定向测试和 typecheck，见各项的“验证”。
6. 全部做完之后（或者用户要求提交之前），跑完整回归：
    ```bash
    npm test --workspace apps/api
    npm test --workspace apps/web
    npm run typecheck --workspace apps/api
    npm run typecheck --workspace apps/web
    npm run lint
    npm run format:check
    npm run e2e --workspace apps/web
    ```
    `format:check` 失败时，运行 `npx prettier --write .`，检查 diff 只涉及你改过的文件，然后重跑。
7. **遇到以下任何情况，停下来问用户，不要自己拍板：**
    - 本文标了【需要决策】的项。
    - 测试需要大面积改写，而不是只改几个 fixture 值。
    - 修复会改变对外 API 的请求或响应格式（M-1b 已经预先说明的部分除外）。
    - LiveKit 本地验证结果和本文的预期不一致（见 M-1a）。
    - API 测试的总运行时间比修改前多出一倍以上。

---

## 1. 执行顺序

| 阶段 | 项目                    | 风险           | 说明                                           |
| ---- | ----------------------- | -------------- | ---------------------------------------------- |
| 1    | L-2、L-1、L-3、I-4、I-6 | 很低           | 几行代码的改动，先热身                         |
| 1    | M-4                     | 低             | 输入长度限制和 body 上限                       |
| 1    | M-2                     | 中             | 安全响应头。CSP 先只做 Report-Only             |
| 2    | M-1a                    | 中             | 听众令牌 `hidden`，**必须用本地 LiveKit 验证** |
| 2    | M-5                     | 中             | 译员和审批员的密码哈希及最小长度               |
| 2    | M-3                     | 中             | 【需要决策】登录锁定策略                       |
| 2    | L-6、L-5                | 中             | 容器用户、依赖升级                             |
| 3    | M-1b                    | 高（改动面大） | connectionSecret，前后端都要改                 |
| 3    | L-4、L-7                | 低             | PBKDF2 迭代次数、转录接口限流                  |
| —    | I-1、I-2、I-3、I-5      | —              | 本轮不改代码，交给用户或安全组决定             |

每做完一项，在本文末尾的“进度记录”里补一行。

---

## 2. 阶段 1

### L-2 维护接口加 admin 角色检查

- **文件**：`apps/api/src/routes/admin.ts`，找到 `backfillDeviceLabelsMatch` 那段（约 1077 行）。
- **改法**：在 `if (request.method === 'POST' && backfillDeviceLabelsMatch) {` 里面最前面加上：
    ```ts
    if (auth!.role !== 'admin') {
        return json({ error: 'admin_role_required' }, { status: 403 });
    }
    ```
    写法和同文件里 `/api/admin/users` 的角色检查保持一致。
- **测试**：在 `apps/api/test/` 下与 admin 权限相关的测试文件里（例如 `admin-sessions.test.ts` 或 `program-access.test.ts`，选结构最接近的一个）新增一个用例：`user` 角色调用该接口返回 403，admin 调用返回 200。
- **验证**：`npm test --workspace apps/api -- <测试文件名>`。

### L-1 修改自己的密码时校验最小长度

- **文件**：`apps/api/src/auth/adminAuth.ts` 里的 `handleChangeOwnPassword`。
- **改法**：
    - 把 `if (!newPassword) { return json({ error: 'invalid_password' }, ...) }` 改为复用 `apps/api/src/domain/users.ts` 里已经导出的 `parseResetPasswordInput`：
        ```ts
        let newPassword: string;
        try {
            newPassword = parseResetPasswordInput({ newPassword: body.newPassword }).newPassword;
        } catch {
            return json({ error: 'invalid_password' }, { status: 400 });
        }
        ```
    - 保留 `invalid_password` 这个错误码，前端可能依赖它，可以 grep `invalid_password` 确认。
- **测试**：在 `apps/api/test/admin-auth.test.ts`（或现有覆盖 `/api/admin/me/password` 的测试文件）里加两个用例：7 位新密码返回 400；8 位成功。
- **前端**：`apps/web/src/features/admin/AccountPanel.tsx` 的新密码输入框如果没有 `minLength={8}`，就加上（纯 UI 提示）。

### L-3 译员令牌只允许发布麦克风

- **文件**：`apps/api/src/livekit/tokens.ts` 里的 `mintTranslatorToken`。
- **改法**：
    ```ts
    import { AccessToken, TrackSource } from 'livekit-server-sdk';
    // ...
    accessToken.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canPublishSources: [TrackSource.MICROPHONE],
        canSubscribe: false,
        canPublishData: false,
    });
    ```
    基线版本的 `livekit-server-sdk` 已经导出 `TrackSource`。先用 ctx7 确认 `canPublishSources` 在 JWT 里的序列化形式（通常是字符串 `"microphone"`）。
- **测试**：`apps/api/test/livekit-tokens.test.ts` 里给 `DecodedJwtPayload.video` 加上 `canPublishSources?: string[]`，在 translator 的用例里断言它等于 `['microphone']`（以实际序列化结果为准）。listener 的用例断言没有这个字段。
- **端到端**：译员页面要能正常发布音频。这一项放到 M-1a 的本地 LiveKit 验证里一起确认。

### I-4 LiveKit 未配置时 webhook 返回 503

- **文件**：`apps/api/src/livekit/webhook.ts` 的 `handleLiveKitWebhook`。
- **改法**：函数开头加
    ```ts
    if (!isLiveKitConfigured(env)) {
        return json({ error: 'realtime_not_configured' }, { status: 503 });
    }
    ```
    `isLiveKitConfigured` 从 `./client` 导入。
- **注意**：`test/livekit-webhook.test.ts` 用的测试 env 默认带 LiveKit 配置（见 `test/test-env.ts`），现有用例应该不受影响。新增一个用例：env 去掉 `LIVEKIT_API_KEY` 后请求返回 503。

### I-6 转录路由的 slug 解码异常

- **文件**：`apps/api/src/routes/transcript.ts` 的 `handleTranscriptRoutes`。
- **改法**：把 `decodeURIComponent(rawSlug ?? '')` 包进 try/catch，出错时返回 `json({ error: 'program_not_found' }, { status: 404 })`。
- **测试**：`apps/api/test/transcript-routes.test.ts` 加一个用例，对 `/api/admin/transcript/%E0%A4%A/session` 发 POST（需要已登录），期望 404 而不是 500。

### M-4 请求体上限和输入长度校验

分三部分。

**(a) Caddy 限制 body 大小**：`Caddyfile` 两个站点块里都加上（先用 ctx7 查 Caddy 的 `request_body` 指令确认语法）：

```
{$DOMAIN} {
	request_body {
		max_size 1MB
	}
	reverse_proxy 127.0.0.1:8787
}
```

`rtc.{$DOMAIN}` 块同样加上（LiveKit 的 twirp 请求都很小）。

**(b) 应用层兜底**：`apps/api/src/index.ts` 的 `app.all('*', ...)` 里，`try {` 之后、health 检查之前加：

```ts
const MAX_BODY_BYTES = 1_048_576; // 写成文件顶部的常量
const contentLength = Number(request.headers.get('content-length') ?? '0');
if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, { status: 413 });
}
```

这只覆盖带 `Content-Length` 的请求；chunked 请求由 Caddy 兜底。在本节或文件注释里写明这一点。

**(c) 听众公开接口的字段长度**：文件 `apps/api/src/routes/listeners.ts`。

- `readRequiredString` 和 `readOptionalString` 增加 `maxLength` 参数，默认 `128`；超长时 `throw new Error(\`${key} is too long\`)`，最终会走到已有的 `validation_error` 400 返回。
- `clientId` 额外校验格式：`/^[A-Za-z0-9_-]{1,128}$/`。前端生成的是 `listener_client_<uuid>`，见 `apps/web/src/routes/ListenerRoute.tsx` 的 `getOrCreateClientId`，可以通过。
- `reason`（`parseLeaveInput`）：最长 64，格式 `/^[a-z_]+$/`。前端现在发送的值有 `listener_left`、`page_unloaded`、`listener_access_removed`，先 grep `apps/web/src` 确认没有遗漏。
- `listenerClientMetadata`：`userAgent` 截断到 512，和 `translator.ts` 的写法一致：`.slice(0, 512)`。
- `cleanQuotedClientHint` 和 `cleanRawClientHint` 的返回值截断到 256。
- **测试**：`apps/api/test/listeners.test.ts` 加用例：
    - `clientId` 为 129 个字符时返回 400。
    - `clientId` 含空格时返回 400。
    - `reason` 为 65 个字符时返回 400。
    - 超长 UA 入库后长度为 512。
    - 应用层：`content-length: 2000000` 的 POST 返回 413。
- **残留风险（不在本轮处理，写进汇报里）**：每主体限流仍然以客户端自选的 `clientId` 为键，单个 IP 仍然可以每分钟创建约 6000 条记录。彻底解决需要按 program 限制待审 claim 和未连接 connection 的数量，作为后续议题。

### M-2 安全响应头

**(a) 应用层**：`apps/api/src/index.ts`。现在已经有一个在 `await next()` 之后设置 `Accept-CH` 的中间件，在同一个中间件里追加：

```ts
c.res.headers.set('X-Frame-Options', 'DENY');
c.res.headers.set('X-Content-Type-Options', 'nosniff');
c.res.headers.set('Referrer-Policy', 'no-referrer');
c.res.headers.set(
    'Permissions-Policy',
    'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
);
c.res.headers.set('Content-Security-Policy-Report-Only', cspValue);
```

- `camera=(self)` 是给审批员扫码用的（`qr-scanner`），`microphone=(self)` 是给译员和转录源控制台用的。**这两项不能写成 `()`。**
- `cspValue` 在 `createApp` 里根据 env 构建一次：
    ```ts
    function buildCsp(env: Env): string {
        const livekit = env.LIVEKIT_URL ? new URL(env.LIVEKIT_URL) : null;
        const livekitSources = livekit
            ? [livekit.origin, livekitHttpUrl(livekit.origin)] // ws(s):// 和 http(s):// 各一个
            : [];
        return [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            `connect-src 'self' ${livekitSources.join(' ')} wss://api.elevenlabs.io`,
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ].join('; ');
    }
    ```
    `livekitHttpUrl` 从 `./livekit/client` 导入。`'unsafe-inline'` 是 Mantine 的内联样式需要的，`fonts.googleapis.com` 和 `fonts.gstatic.com` 来自 `apps/web/index.html`，ElevenLabs 的地址来自 `apps/web/src/lib/transcript/scribeSession.ts`。
- **注意**：浏览器在 Report-Only 模式下会**忽略** `frame-ancestors`，所以真正防点击劫持靠的是 `X-Frame-Options: DENY`。两个都要设置。
- **本轮不要把 CSP 切成强制模式。** 在 dev 环境逐个打开 `/manage`、听众页、译员页、审批员扫码页、`/{slug}/source`，用浏览器控制台检查有没有 CSP 违规报告，把结果写进汇报，由用户决定什么时候切换成强制。

**(b) HSTS 放在 Caddy**：`Caddyfile` 的 `{$DOMAIN}` 块里加
`header Strict-Transport-Security "max-age=31536000"`（先用 ctx7 确认 `header` 指令语法）。先**不要**加 `includeSubDomains` 和 `preload`，等用户确认域名下没有其他需要 http 的子域再说。

**测试**：`apps/api/test/static-serving.test.ts` 或 `health.test.ts` 里断言：`/api/health` 和 SPA 首页的响应都带上述头；CSP 里包含 `frame-ancestors 'none'`，并且包含测试 env 的 LiveKit origin。

---

## 3. 阶段 2

### M-1a 听众令牌设为 hidden（关键修复）

- **文件**：`apps/api/src/livekit/tokens.ts` 的 `mintListenerToken`。
- **改法**：在 grant 里加上 `hidden: true`。
- **为什么够用**：hidden 参与者不会出现在其他参与者的参与者列表里，其他听众就拿不到 `listener:<connectionId>` 这个 identity 和 metadata。hidden 参与者仍然可以订阅译员的音轨。
- **测试**：`livekit-tokens.test.ts` 断言 listener 的 `video.hidden === true`，translator 没有这个字段（**译员不能 hidden**，否则听众端看不到发布者）。
- **必须做的本地验证**（不能只跑单测）：
    1. 用 `npm run dev` 启动带 LiveKit 的开发环境。
    2. 开一个译员页面开始发布，开两个听众页面（两个浏览器 profile 或无痕窗口）选同一个语言。
    3. 确认两个听众**都能听到声音**。
    4. 确认管理端该语言的在线听众数是 2。这验证 hidden 参与者仍然会触发 `participant_joined` webhook。presence 计数靠这个 webhook，如果计数不涨，就说明 hidden 参与者不触发 webhook。
    5. 在听众 A 的浏览器控制台里确认看不到听众 B。可以临时加日志打印 `room.remoteParticipants`，只应该看到 `translator:...`；临时日志不要提交。
    6. 关掉一个听众页面，在线数回到 1。
- **如果第 4 步计数不涨：停下来报告，不要继续改。** 备选方案需要和用户讨论。
- 顺带验证 L-3：确认译员页的音频发布正常。

### M-5 译员和审批员的密码哈希及最小长度

**目标**：

- 手动设置的密码（译员的 `translatorPassword` / `reset-password`、审批员手动设置的密码）至少 12 位。
- 新写入的哈希改为 PBKDF2，带每行随机 salt，同时保留 pepper。
- 比较改为恒定时间比较。
- 旧格式 `sha256:<hex>` 仍然能验证，以兼容已有数据库。

**步骤**：

1. 新建 `apps/api/src/auth/passwordHash.ts`：
    - 把 `apps/api/src/db/usersRepository.ts` 里的 `deriveKeyHex` 和 `toHex` 移过来并导出，`usersRepository.ts` 改为从这里导入，行为不变。
    - 新增：
        ```ts
        // 存储格式：pbkdf2$<iterations>$<saltHex>$<hashHex>
        export async function hashPepperedPassword(
            password: string,
            pepper: string,
        ): Promise<string>;
        export async function verifyPepperedPassword(
            password: string,
            pepper: string,
            stored: string,
        ): Promise<boolean>;
        ```
        - hash 时生成 16 字节随机 salt，迭代次数用 `PBKDF2_ITERATIONS`（从 `usersRepository.ts` 导入，或者一起移过来）。输入是 `password + pepper`。
        - verify 时：
            - 以 `pbkdf2$` 开头：按存储的参数重新计算，用 `timingSafeEqualHex` 比较。
            - 以 `sha256:` 开头（旧格式）：计算 `sha256(password + pepper)`，用 `timingSafeEqualHex` 比较。
            - 其他格式一律返回 false。
2. `apps/api/src/db/translatorRepository.ts`：
    - 私有方法 `passwordHash` 改为调用 `hashPepperedPassword`。
    - `verifyPassword` 里的 `candidate !== translator.passwordHash` 改为 `await verifyPepperedPassword(password, passwordPepper, translator.passwordHash)`。
    - 注意 `verifyPassword` 还会检查 `accessExpiresAt`，这段逻辑保持不变。
3. `apps/api/src/db/approverRepository.ts`：
    - `buildCredentialChange` 写哈希的地方改为 `hashPepperedPassword`。
    - `authenticate` 改为 `verifyPepperedPassword`。账号不存在时仍然要做一次等量的哈希计算（`DUMMY_PASSWORD_HASH` 那个分支），防止时间侧信道。可以对一个固定的 `pbkdf2$...` 假值调用 verify。
    - `MINIMUM_PASSWORD_LENGTH` 从 8 改为 12。
    - 生成的密码（`GENERATED_PASSWORD_LENGTH = 10`，base32，50 bit）可以保持不变，或者提到 12 位，在汇报里写明你的选择。
4. 最小长度：
    - `apps/api/src/domain/programs.ts`：`translatorPassword`（`parseCreateStreamInput`）和 `parseResetTranslatorPasswordInput` 的 `password`，从 `requireString` 改为至少 12 位的校验，报错信息写成 `password must be at least 12 characters`。
    - 前端 `apps/web/src/features/admin/AdminScreen.tsx`：`Translator password` 的 `TextInput` 加 `minLength={12}`；审批员密码框的 `minLength={8}` 改为 12；如果有重置译员密码的表单，同样处理（grep `reset-password` 和 `resetTranslatorPassword`）。
5. 修正 `.env.example` 里 `TRANSLATOR_PASSWORD_PEPPER` 上方那段关于“per-row salt”的注释，让它和实际实现一致。
6. **测试**：
    - 新建 `apps/api/test/passwordHash.test.ts`，覆盖：新格式能验证；旧 `sha256:` 格式能验证；错误密码返回 false；pepper 不同时返回 false；未知前缀返回 false。
    - 现有测试里，作为**正确密码**被设置的、少于 12 位的 fixture 要改长。例如 `secret-pass`（11 位）这类值，用 `grep -rn "password: '" apps/api/test apps/web/test apps/web/e2e` 找出来。故意用来测“错误密码”的值不需要改。
    - 新增：创建 stream 时 `translatorPassword` 为 11 位返回 400；审批员手动设置 11 位密码返回 400。
    - 跑 `npm test --workspace apps/api`，对比改动前后的总耗时（PBKDF2 比 SHA-256 慢）。如果耗时翻倍，按第 0 节第 7 条停下来问。

### M-3 登录锁定策略【需要决策】

**问题**：账号级的锁定桶（译员按 stream、审批员按 program、admin 按用户名）的键都是公开的，外部可以故意触发锁定。

**推荐方案（需要用户确认后再做）**：账号级的桶**只计数、不锁定**，硬锁只保留在 IP 桶上。弱口令风险由 M-5 的 12 位最小长度和 PBKDF2 弥补；随机生成的译员链接 token 有 256 bit，不可能被暴力破解。

确认后的改法：

1. `apps/api/src/auth/loginThrottle.ts`：
    - `Bucket` 类型加 `locks: boolean`。
    - `adminLoginBuckets` 和 `translatorLoginBuckets` 里，user / translator-user 桶设为 `locks: false`，IP 桶设为 `locks: true`。
    - `recordLoginFailure` 里，`locks: false` 的桶永远不写 `locked_until`。可以在计数达到阈值时输出一条 `console.warn` 结构化日志（`login_account_threshold`），**日志里不能有用户名或 IP 明文**，只写桶的类型。
    - `loginThrottleStatus` 不需要改。
2. `apps/api/src/db/approverRepository.ts`：program 级计数（`ip_hash = ''` 那一行）同样不再写 `locked_until`；`isLocked` 只看 IP 行。注意 `routes/approver.ts` 里的 `firstThresholdBreach` 逻辑也依赖 program 计数，要一起调整，让它只反映 IP 桶。
3. **测试**：
    - `admin-auth.test.ts`（约 170 行）、`translator-auth.test.ts`（约 446 行）和 `approver-auth.test.ts` 里断言“同一账号多次失败后 429”的用例，改为“同一 IP 多次失败后 429”。
    - 新增“不同 IP 对同一账号失败超过旧阈值后，正确密码仍然能登录”的用例。测试里可以通过设置 `X-Forwarded-For` 来模拟不同 IP（`clientIp` 读取这个头）。
    - 如果用户选择其他方案（例如只调高阈值），按用户的要求做。

### L-6 容器以非 root 运行

- **文件**：`Dockerfile` 的 runtime 阶段。
- **改法**：在 `WORKDIR /app/apps/api` 之前加
    ```dockerfile
    RUN mkdir -p /data && chown node:node /data
    ```
    在 `CMD` 之前加 `USER node`。
- **原因**：Docker 首次挂载空的命名卷时，会把镜像里 `/data` 的属主复制过去，所以新部署可以直接用。
- **已有部署**：现有的 `bhasha_data` 卷属主是 root，需要执行一次下面的命令。写进汇报，并加到 `docs/deployment.md` 的升级说明里；**不要自己在任何服务器上执行**：
    ```bash
    docker compose run --rm --user root app chown -R node:node /data
    ```
- **验证**：本地 `docker compose build app`。如果本地能起完整栈（需要 `.env`，不要打印内容），确认应用能启动并能写数据库。不能起就在汇报里说明没有验证。

### L-5 依赖升级

1. 先运行 `npm audit fix`（不带 `--force`），然后看 `git diff package-lock.json package.json` 有哪些包变了。
2. vite 需要升到 8.3.x：只修改 `apps/web/package.json` 里 vite 的版本范围，然后 `npm install`。vitest 有同样的问题时按 audit 的提示升级。
3. 确认 `hono` 和 `@hono/node-server` 已经升到 audit 显示的修复版本。
4. 跑**完整回归**（第 0 节第 6 条），包括 e2e 和 `npm run build --workspace apps/web`。
5. 再跑一次 `npm audit`，把剩余项和每一项不修的理由写进汇报（例如：只影响开发依赖、或者是 RSC 模式不适用）。
6. 不要顺手做无关的大版本升级。

---

## 4. 阶段 3

### M-1b connectionSecret（纵深防御，改动面大）

M-1a 关闭了 connectionId 的泄露途径，这一项让 connectionId 即使泄露了也没法用。**开工前和用户确认是否要在本轮做。**

设计：

- `listener_connections` 表新增 `connection_secret_hash TEXT` 列（可以为空，旧行为空）。
    - 写进 `apps/api/src/db/schema.sql`。
    - 照 `apps/api/src/db/migrate.ts` 里 `access_expires_at` 的做法，为已有数据库补列（`PRAGMA table_info` 检查后再 `ALTER TABLE`）。
- `/api/listeners/request`、`/switch`、`/reconnect` 创建新连接时，生成 32 字节随机 secret（参照 `listenerAccessRepository.ts` 的 `randomHex`），库里只存 `sha256(secret)`，响应改为 `{ connectionId, connectionSecret }`。
- 以下接口都要求请求体带上被引用连接的 secret，用 `timingSafeEqualHex` 比较哈希：
    - `/token`、`/connected`、`/heartbeat`、`/leave`：带 `connectionSecret`。
    - `/switch`：带 `fromConnectionSecret`。
    - `/reconnect`：带 `reconnectOfConnectionSecret`。
    - 校验失败一律返回 `404 listener_connection_not_found`，不泄露连接是否存在。
    - `connection_secret_hash` 为空的旧行一律拒绝。产品还没上线，接受这个行为；在汇报里写明。
- 前端：`apps/web/src/api/listeners.ts` 和 `apps/web/src/realtime/listenerClient.ts`，以及 `ListenerRoute.tsx` 里保存 connectionId 的地方，都要跟着保存和传递 secret。页面卸载时调用 `/leave` 也要带上 secret（grep `page_unloaded` 找到这个调用）。
- **测试**：
    - API 测试覆盖：缺少 secret 返回 404；secret 错误返回 404；正确时成功。
    - 现有的听众相关测试需要统一更新请求体，最好抽一个测试 helper，避免逐个改。
    - 前端单测（`listenersApi.test.ts`、`listenerRealtimeClient.test.ts`）以及 e2e（`apps/web/e2e/listener.spec.ts`、`e2e/support/fakeLivekitClient.ts`）也要更新。
- 做完后跑完整回归。

### L-4 admin 密码 PBKDF2 迭代次数

- `apps/api/src/db/usersRepository.ts`：`PBKDF2_ITERATIONS` 改为 `600_000`。如果 M-5 已经把常量移走，就去新位置改。
- 删除 `apps/api/test/users.test.ts` 里约 257 行的“keeps PBKDF2_ITERATIONS within the Cloudflare Workers 100k cap”用例，以及不再需要的 `WORKERS_PBKDF2_MAX_ITERATIONS` 常量。
- 登录成功后自动升级旧哈希：在 `apps/api/src/auth/adminAuth.ts` 的 `handleLogin` 里，`verifyPassword` 成功之后，如果 `user.passwordIterations < PBKDF2_ITERATIONS`，就调用 `await users.setPassword(user.id, password)`。
- **测试**：新增“用 10 万次迭代存的旧哈希登录成功后，库里的迭代次数变为 60 万”。比较测试耗时，翻倍就停下来问。可以考虑让测试 env 用较低的迭代次数，但这需要先问用户。

### L-7 转录接口限流

- **文件**：`apps/api/src/routes/transcript.ts`。复用 `apps/api/src/security/rateLimiter.ts` 里的 `RateLimiter` 类。
- 在模块里创建两个限流器（或者通过 `TranscriptDeps` 注入，方便测试）：
    - `session`：每个 userId 每分钟 10 次。
    - `events`：每个 userId 每分钟 600 次。转录的 partial 事件比较频繁，阈值要宽松；先看一下 `apps/web/src/lib/transcript/sourceRelay.ts` 的发送频率，确认 600 够用。
    - 超限时返回 `429 { error: 'rate_limited' }`，并带 `retry-after` 头，返回格式和 `ListenerRateLimiter.respond` 一致。
- 译员 SSE（`handleTranslatorStream`）：每个译员会话最多 3 条并发连接。用一个 `Map<sessionId, number>` 计数，在 `cleanup` 里减一，超限返回 429。
- **测试**：`apps/api/test/transcript-routes.test.ts` 加对应用例。

---

## 5. 本轮不改代码的项（汇报时原样转交用户）

- **I-1 CSRF 的 Origin 校验**：dev 环境里 Vite 代理（5173 端口）的 Origin 和 API 不同源，简单加校验会把开发环境搞坏。需要先设计允许列表，交给安全组评估。
- **I-2** 公开接口返回最近 90 秒审批通过的 claimId：需要先确认前端是否依赖这个接口（grep `access/approved`），再决定是否下线。
- **I-3** 听众 access token 可以共享：这是产品层面的决策。
- **I-5** LiveKit TURN 能否中继到 `127.0.0.1` 或 `169.254.169.254`：需要安全组在真实 VM 上验证。

---

## 6. 汇报模板（每个阶段结束后填写）

```
### 阶段 N 汇报
- 完成项：L-2, L-1, ...
- 改动文件：（逐个列出）
- 新增或修改的测试：（列出）
- 运行的检查及结果：（命令 + 通过/失败；失败要贴输出）
- 未验证的内容及原因：
- 偏离本手册的地方及理由：
- 需要用户决策的问题：
```

## 7. 进度记录

| 项目 | 状态     | 备注                                                       |
| ---- | -------- | ---------------------------------------------------------- |
| L-2  | 已完成   | 已改，已测                                                 |
| L-1  | 已完成   | 已改，已测（含前端 minLength）                             |
| L-3  | 已完成   | 已改，已测；译员发布待 M-1a 本地验证                       |
| I-4  | 已完成   | 已改，已测                                                 |
| I-6  | 已完成   | 已改，已测                                                 |
| M-4  | 已完成   | 已改，已测；Caddy 语法已用 ctx7 核对，未实机验证           |
| M-2  | 已完成   | 已改，已测；CSP 仅 Report-Only，浏览器控制台逐页检查尚未做 |
| M-1a | 未开始   |                                                            |
| M-5  | 未开始   |                                                            |
| M-3  | 等待决策 |                                                            |
| L-6  | 未开始   |                                                            |
| L-5  | 未开始   |                                                            |
| M-1b | 等待决策 |                                                            |
| L-4  | 未开始   |                                                            |
| L-7  | 未开始   |                                                            |
