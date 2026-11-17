# 观鸟工作台

个人观鸟名录。主页就是工作台：IOC World Bird List v15.2（11,064 种），按中文名、英文名、拉丁名检索，目 → 科 → 属级联筛选，已观察 / 未发现，以及每种鸟自己的观察、野外照片和手记。

线上页面：<https://serinshen.github.io/bird-workbench/>

晨间物种卡是另一个站点，只从侧栏和 17 种鸟的页面链出去：<https://serinshen.github.io/species-archive/>。鸟况周报的第一期预定 2026-11-20，尚未刊出。

## 数据

- `data/pack.b64`：IOC v15.2 名录（gzip + base64）。中文名取自名录；23 个没有中文名的种保持空白。
- `data/china-recordable-sci.json`：中国可记录 1,491 种，只做筛选，不是另一套分类。
- `data/observations.json`：观察记录。一种鸟只要有至少一条记录，即为已观察。
- `data/notes.json`：手记，按学名保存。
- `photos/`：野外照片。页面不用图库、维基或生成图充当这些照片。

目、科在筛选里显示「中文名 + 拉丁名」。属只显示拉丁属名。屏幕上的科名来自 IOC 名录。导入记录里原来的类群写法留在每条记录的 `sourceGroup`，不覆盖名录。

已导入 6 条鸟类记录（2026-11-10、2026-11-11，华蓥山一带）。黄眉柳莺仍是中等偏高 / tentative，尚未完全排除黄腰柳莺。蓝额红尾鸲和红头穗鹛是听到、仅听见未见、尚未独立核对。

## 本地查看

```bash
python3 -m http.server 8765
```

打开 <http://127.0.0.1:8765/>。名录和已导入的记录不需要登录。本地回调和线上 OAuth App 不是同一个地址，所以在本地登录不会完成。

## 登录并写回这个仓库

阅读不需要登录。添加观察、上传野外照片、写手记时，用你自己的 GitHub 账号走 OAuth，再由 GitHub API 以你的身份提交到本仓库的 `main`。提交者是登录的那个用户。

浏览器不能保管 client secret，GitHub 的令牌端点也没有对网页开放 CORS，所以换令牌要经过 `oauth/worker.js`。Client ID 还没写上、或令牌交换还没接上时，登录不会变成已登录。

### 1. 注册 OAuth App

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。

- Application name：`观鸟工作台`
- Homepage URL：`https://serinshen.github.io/bird-workbench/`
- Authorization callback URL：`https://serinshen.github.io/bird-workbench/`

回调地址要和上面这一行完全一致，包括末尾的斜线。记下 Client ID。Client secret 只放在 worker 的环境变量里，不要写入 `js/config.js`，不要提交到仓库。

### 2. 部署令牌交换

`oauth/worker.js` 是一个 Cloudflare Worker。它把浏览器发来的 `code` 和 PKCE `code_verifier` 转给 `https://github.com/login/oauth/access_token`，并附上 secret。来源只允许 `https://serinshen.github.io`，回调只接受上面的 Pages 地址。

环境变量：

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

```bash
npx wrangler deploy oauth/worker.js --name bird-workbench-oauth
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

部署完成后会得到类似 `https://bird-workbench-oauth.<account>.workers.dev` 的地址。也可以换成任何你自己的 HTTPS 服务，只要：

- `POST /exchange`，JSON 为 `{ "code", "redirect_uri", "code_verifier" }`
- `POST /refresh`，JSON 为 `{ "refresh_token" }`
- 返回 GitHub 的 JSON（含 `access_token`）
- 带上允许 `https://serinshen.github.io` 的 CORS 头

### 3. 填写 js/config.js

```js
window.WORKBENCH_CONFIG = {
  owner: "serinshen",
  repo: "bird-workbench",
  branch: "main",
  oauthClientId: "你的 Client ID",
  redirectUri: "https://serinshen.github.io/bird-workbench/",
  tokenExchangeUrl: "https://bird-workbench-oauth.<account>.workers.dev",
  scope: "public_repo",
};
```

`tokenExchangeUrl` 只写 worker 的源站，不要带 `/exchange`。`public_repo` 足够把记录写进这个公开仓库。

改完 `js/config.js` 后提交到 `main`，等 Pages 更新再登录。

### 4. 使用

打开网站，点「登录」，在 GitHub 上授权。进入某个物种后可以记下观察（地点、时间、性别、看到或听到、照片、备注、置信）和手记。成功后，仓库里会多一次由你的账号作出的提交：`data/observations.json`、`data/notes.json` 和 `photos/`。

退出只清掉这个浏览器标签页里的令牌。若要作废授权，到 GitHub → Settings → Applications 里撤销这个 OAuth App。若 OAuth App 打开了会过期的令牌，worker 的 `/refresh` 会在令牌失效时换一次新的。
