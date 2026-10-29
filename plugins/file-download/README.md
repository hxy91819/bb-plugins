# File Download

纯插件下载本地文件的原始字节到浏览器设备。插件 ID 和集合安装名均为 `file-download`；没有配置、存储、后台服务或新增 HTTP 路由。

## 使用

聊天文件链接右键菜单选择 **Open with Download**，打开面板后点击 **Download**。使用 SDK `experimental_FileLink` 的界面将入口放在 **Open with → Download**；文件面板也提供 Open with 切换。公开 SDK 0.6.75 没有文件菜单 action slot，所以这不是菜单顶层的一键 Download。

支持 `html`、`htm`、`txt`、`md`、`json`、`csv`、`pdf`、`zip`。SDK 不支持通配扩展名；不提供另一套文件浏览器。`fileOpener` 会参与默认打开器选择：没有已保存偏好时，BB 按确定顺序选择第一个匹配打开器。用户可以在 Settings → Files 固定 BB preview，按需再选择 Download。停用插件后恢复 BB 原有处理。

面板不会自动下载或执行 HTML。**Show BB preview** 是显式打开 BB 原有预览；下载按钮始终读取源文件，不使用预览内容。`started` 只表示浏览器或设备接管，插件不会声称文件已经保存完成。

## 调用与边界

前端 `useSdk()` 复用当前登录身份，不读取服务器本地磁盘，不使用 DOM 菜单注入或私有 HTTP URL：

- workspace：环境的 `hostId/path`；无环境时从项目 sources 选择显式 host，缺省采用 `system.config().primaryHostId`，与 BB 项目预览一致。
- thread-storage：`threads.storageLocation()` 的 host 和 storageRootPath，独立于线程环境所在 host。
- host：绝对路径及 opener 的 `experimental_hostId`，或其环境 host；不能定位 host 时直接报错，不回退主 host。

`files.read({hostId, path, rootPath?, signal})` 使用现有认证、host 可用性和路径校验。workspace/storage 传入从 SDK 得到的 root，交由 host 的 realpath 校验拒绝越界符号链接；相对路径拒绝绝对地址、空片段及 `.`/`..`。host 来源沿用 BB 绝对文件预览的授权范围。插件不创建接受任意路径的下载接口。

有效 UTF-8 内容以 TextEncoder 还原（保留 BOM/CRLF），base64 内容按字节解码；以 `application/octet-stream` Blob 和原始 basename 调用 `experimental_saveFile`。不做换行、编码或文件名 URL 解码。沿用 `files.read` 的现有大小限制（本基线非图片 25 MiB）；文件整个加载进内存，不提供大文件流式下载。目录、拒绝读取、host 离线和过大文件显示原 SDK 错误；保存启动失败沿用 BB toast，并在面板显示失败。卸载面板/切换文件时取消未完成读取。

BB SDK 声明浏览器/桌面使用下载，iOS shell 使用系统分享面板；移动浏览器由自身下载行为决定。真实浏览器、桌面和 iOS 保存行为尚待安装验收。

## 开发与验收

使用 BB `fork-v0.47.0-20261029.1` 对应的公开 SDK tarball（0.6.75），不能用集合旧基线或同号但接口不同的上游包替代。重型任务获串行资源后，在本目录执行：

```sh
npm ci --no-audit --no-fund --legacy-peer-deps
npm run typecheck
npm test
bb plugin build .
```

所有检查应在宿主资源隔离 scope 中运行。`package-lock.json` 复用集合已锁定的工具链，SDK 换为上述实际发布包的 SHA-512，补齐其新增的 TanStack 两项依赖；本轮没有执行 npm 安装，需串行冷安装核验 lockfile。

本轮轻量验证使用真实发布 SDK 声明与现有工具链，只临时链接依赖；9 个行为夹具覆盖原始字节、host/root 选择、非法路径和错误传播。错误夹具验证传播，不代表实测了服务端拒绝策略。尚未执行真实 bundle 构建、插件安装或 live UI 验收。

安装后须验收：截图对应菜单入口；中文空格 HTML 下载后比较 SHA-256；两台 host 同路径不同内容；环境/线程存储；不存在、离线、越界符号链接与 25 MiB 限制；重复点击、关闭面板及禁用插件；桌面浏览器、窄屏移动浏览器和原生 shell。保留既有插件的 enabled、配置和数据。
