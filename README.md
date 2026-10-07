# NBM  (by lu8010252)

导航页 + 服务器监控。一个镜像,两种模式:

| 模式 | 文件 | 用途 |
|---|---|---|
| 面板 | `docker-compose.yml` | 带网页,汇总所有服务器、检测网站、发 ntfy 告警 |
| 探针 | 面板里生成的 `docker run` 命令 | 给被监控的机器用,只开 `/api/stats`,没有网页 |

## 主面板(不用下载源码)
镜像由 GitHub Actions 自动构建,支持 amd64 / arm64 / armv7:`ghcr.io/lu8010252/nbm:latest`

    # 1. 新建文件夹,把本仓库 docker-compose.yml 的内容保存进去(或在 1Panel「容器 → 编排」里粘贴)
    # 2. 把 TOKEN、PANEL_PASS 的 CHANGE_ME 改成自己的值
    docker compose up -d
    # 访问 http://服务器IP:8060
    # 更新: docker compose pull && docker compose up -d   (数据在 ./data,不会丢)

想本地改代码构建:克隆仓库后把 compose 里的 `image:` 换成 `build: .`,再 `docker compose up -d --build`。

## 被监控的服务器(探针)
不用复制任何文件。在主面板点「添加服务器」,页面会自动生成 TOKEN 和一条 `docker run` 命令,
复制到那台机器上运行即可(只需要装了 Docker,会拉取 node:20-alpine)。记得放行 8060 端口。
探针只有一个几 KB 的 agent.js,没有网页,内存限制 64MB。
升级探针:`docker rm -f nbm-agent` 后重新运行命令。

## 数据与备份
`./data/` 里是配置、历史曲线、告警记录和自定义代码,备份这个文件夹即可。
自定义代码:`data/custom/index.js` 和 `index.css`,网址后加 `?safe=1` 可临时禁用。

## 可选:给面板加登录
docker-compose.yml 里取消 `PANEL_USER` / `PANEL_PASS` 两行注释(探针接口不受影响,仍用 TOKEN)。

## 首页搜索框
点一下搜索框会弹出常用书签(设置 → 书签里点 ☆ 固定的那些;都没固定就显示「常用」文件夹或前 8 个)。
输入文字时会联想匹配的书签,↑↓ 选择、回车打开;不选就是正常搜索。

## 公网 IP
每台服务器的卡片和详情页都显示公网 IP,默认打码成 `***.***.***.***`,点旁边的眼睛才显示(只对当前页面有效,刷新后重新打码)。
IP 由探针自动探测上报;探针还没升级、或探测不准时,可以在服务器「编辑」里手动填,手动填的优先。
**升级探针**才能上报 IP:`docker rm -f nbm-agent` 后重新运行部署命令(或重新 build)。

## 网页 SSH
1. **必须先设置面板登录**:docker-compose.yml 里取消 `PANEL_USER` / `PANEL_PASS` 两行注释并改成自己的密码。没设置时终端不会启用(避免任何人打开网页就能连你的服务器)。
2. 服务器「编辑」里勾选「启用网页 SSH」,填 SSH 地址(面板所在的这台填 `127.0.0.1`;远程服务器留空则用探针地址里的主机)、端口、用户名,认证方式三选一:密码 / 私钥 / 每次连接时输入密码(不保存)。
3. 服务器卡片右上角的 SSH 按钮,或详情页的 SSH 按钮,打开终端。手机上有一排 Esc / Tab / Ctrl+C / 方向键的辅助按键。

说明:
- 密码 / 私钥明文保存在 `data/config.json`(和 TOKEN 一样),设置页不会回显,接口也不会返回。备份 `data/` 时注意别外传。
- 首次连接会记住对方主机指纹,以后指纹变了会拒绝连接(防中间人);重装过系统的服务器,在「编辑」里勾「重新信任主机指纹」。
- 通过反向代理(1Panel 网站 / Nginx)访问面板时,需要开启 WebSocket 支持并保留 Host 头;直接用 `http://IP:8060` 访问无需设置。
- 同时最多 8 个 SSH 会话。
- 面板依赖 `ssh2`、`ws`(package.json),Dockerfile 构建时自动安装;探针 `agent.js` 仍然零依赖。

## 更新面板
覆盖源文件(**不要动 `data/` 目录**)后:`docker compose up -d --build`。

## 镜像拉取失败
- 提示 `unauthorized` / `not found`:镜像还是私有的。仓库所有者到 GitHub 个人主页 → Packages → 点开该镜像 →
  Package settings → Change visibility 设为 Public(只需设置一次)。
- 国内服务器拉 `ghcr.io` 很慢或超时:换用能访问 ghcr.io 的机器拉取后 `docker save` / `docker load`,或给 Docker 配置镜像加速/代理。
