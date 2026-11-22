# 观鸟工作台

个人观鸟名录。主页就是工作台：IOC World Bird List v15.2（11,064 种），按中文名、英文名、拉丁名检索，目 → 科 → 属级联筛选。一种鸟至少有一条「看到」才算已发现；记录若全部是「听到」，则是仅听到，不计入已发现；没有记录就是未发现。状态只由记录推导。每种鸟有自己的观察、野外照片和手记。收藏的野外照片在「影像记录」。

正在用的页面从 Cloudflare Worker 读记录、手记和照片。git 里的 `data/observations.json`、`data/notes.json` 和 `photos/` 是备份。登录只用邮箱里的一次性登录码或链接，详见 [SETUP.md](SETUP.md)。

线上的 GitHub Pages 仍是改动之前的站点：<https://serinshen.github.io/bird-workbench/>。这次改动不发布到那里。

晨间物种卡是另一个站点，只从侧栏和物种页链出去：<https://serinshen.github.io/species-archive/>。鸟况周报在 `#/weekly`，各期写在 `data/weekly-issues.json`，不从观察记录生成。第一期覆盖 2026-11-13 至 2026-11-19，刊期 2026-11-20。

## 数据

- `data/pack.b64`：IOC v15.2 名录（gzip + base64）。中文名取自名录；23 个没有中文名的种保持空白。
- `data/china-recordable-sci.json`：中国可记录 1,491 种，只做筛选，不是另一套分类。
- `data/observations.json`：备份。观察方式在导入时把原来的 `seen`、`seen_heard` 记为看到，`heard_only` 记为听到。`可疑` 只在原来的 `tentative` 为 true 时打开。
- `data/notes.json`：手记备份，按学名保存。
- `data/weekly-issues.json`：鸟况周报。每期手写，页面按刊期从新到旧排列。
- `photos/`：野外照片备份。长边不超过 2000 像素，画面上有 `@SerinS`。文件里的 JPEG 注释 `WBWM:@SerinS` 用来跳过已经处理过的照片。

目、科在筛选里显示「中文名 + 拉丁名」。属只显示拉丁属名。屏幕上的科名来自 IOC 名录。导入记录里原来的类群写法留在每条记录的 `sourceGroup`，不覆盖名录。

时间按 Asia/Shanghai 保存，页面只显示日期和小时:分钟，不显示时区名称。没有钟点的记录只显示日期。

## 本地查看

先按 [SETUP.md](SETUP.md) 做本地迁移，再：

```bash
npx wrangler dev
```

名录本身也可以用静态服务器打开，但观察记录要等 Worker：

```bash
python3 -m http.server 8765
```

## 谁可以写

不登录可以看名录、记录和影像记录。只有 `ALLOWED_EMAIL` 里的邮箱登录之后才能添加、修改、收藏、上传和删除。允许名单留空时，登录框还在，但登录不会成功。

朋友用只读链接打开 `#/share/…`，不登录也能看全部观察，不能改。

删除一条观察前会先确认。删掉之后，只属于这条记录的照片会从 R2 去掉，收藏也会一起离开影像记录。
