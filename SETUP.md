# 接上工作台

页面和接口由同一个 Cloudflare Worker 提供。记录在 D1，野外照片在 R2。git 里的 `data/observations.json`、`data/notes.json` 和 `photos/` 只作备份，运行中的页面不读它们。

不要把密钥写进 git，也不要写进 `js/config.js`。`apiOrigin` 留空：页面和接口同一来源。

这一步不会绑定正式域名，也不会改已经在 GitHub Pages 上的站点。

## 需要的密钥

全部用 `wrangler secret put`，或本地的 `.dev.vars`（这个文件不要提交）。

| 名称 | 作用 |
| --- | --- |
| `SESSION_SECRET` | 给登录 cookie 签名。用一段足够长的随机字符串。 |
| `ALLOWED_EMAIL` | 允许登录的邮箱。可以逗号分隔多个。留空时登录框仍在，但任何邮箱都不能登录。 |
| `RESEND_API_KEY` | Resend 免费档的 API key，用来发登录信。 |
| `RESEND_FROM` | 发信地址，例如已在 Resend 验证过的域名，或免费档允许的测试发信地址。 |

登录信只在新设备或退出之后再发。同一台设备的 cookie 会保持登录。

## 命令

在项目根目录：

```bash
npm install
npx wrangler d1 create bird-workbench
npx wrangler r2 bucket create bird-workbench-photos
```

把 `wrangler.jsonc` 里的 `database_id` 换成 `d1 create` 打印出来的 id。现在文件里的 `00000000-0000-0000-0000-000000000001` 只是占位，不能拿去部署。

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ALLOWED_EMAIL
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM

# 本地
npx wrangler d1 migrations apply bird-workbench --local
node scripts/migrate.mjs --local

# 远端。需要已登录的 Cloudflare 账号。没有账号就不要跑。
npx wrangler d1 migrations apply bird-workbench --remote
node scripts/migrate.mjs --remote

npx wrangler dev
# 准备好再发布到 *.workers.dev。不要加自定义域名。
# npx wrangler deploy
```

`node scripts/migrate.mjs` 不加 `--local` 或 `--remote` 时只检查备份，不写入。D1 里已经有记录时，脚本会停下来；确认要用 git 备份覆盖时才加 `--replace`。

迁移会原样复制照片，不重新加水印。`WBWM:@SerinS` 仍在文件里。

## 本地没有 Cloudflare 账号时

`wrangler dev` 和 `--local` 可以在这台机器上跑 D1 / R2。`wrangler deploy`、`--remote` 和任何 `*.workers.dev` 预览地址都要账号，不能在没有凭证时做出来。
