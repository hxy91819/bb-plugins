# File Download

纯插件下载本地文件的原始字节到浏览器设备。插件 ID 和集合安装名均为 `file-download`；没有配置、存储、后台服务或新增 HTTP 路由。

## 使用

聊天文件链接右键菜单选择 **Open with Download**，打开面板后点击 **Download**。使用 SDK `experimental_FileLink` 的界面将入口放在 **Open with → Download**；文件面板也提供 Open with 切换。公开 SDK 0.6.75 没有文件菜单 action slot，所以这不是菜单顶层的一键 Download。

支持 `html`、`htm`、`txt`、`md`、`json`、`csv`、`pdf`、`zip`。SDK 不支持通配扩展名；不提供另一套文件浏览器。`fileOpener` 会参与默认打开器选择：没有已保存偏好时，BB 按确定顺序选择第一个匹配打开器。无论默认选择还是手动选择，本插件都立即呈现 BB 的 Original 预览，并在上方增加 Download 工具栏，无需在每台设备修改 Settings。已固定其他打开器的偏好仍由 BB 保留。停用插件后恢复 BB 原有处理。

面板不会自动下载；默认预览完全委托 BB 的 Original，HTML 的原有预览行为保留。Download 的读取和状态变化不卸载、重挂载或额外执行 Original；按钮始终读取源文件，不使用预览内容。`started` 只表示浏览器或设备接管，插件不会声称文件已经保存完成。

## 调用与边界

前端 `useSdk()` 复用当前登录身份，不读取服务器本地磁盘，不使用 DOM 菜单注入或私有 HTTP URL：

- workspace：环境的 `hostId/path`；无环境时从项目 sources 选择显式 host，缺省采用 `system.config().primaryHostId`，与 BB 项目预览一致。
- thread-storage：`threads.storageLocation()` 的 host 和 storageRootPath，独立于线程环境所在 host。
- host：绝对路径及 opener 的 `experimental_hostId`，或其环境 host；不能定位 host 时直接报错，不回退主 host。

`files.read({hostId, path, rootPath?, signal})` 使用现有认证、host 可用性和路径校验。workspace/storage 传入从 SDK 得到的 root，交由 host 的 realpath 校验拒绝越界符号链接；相对路径拒绝绝对地址、空片段及 `.`/`..`。host 来源沿用 BB 绝对文件预览的授权范围。插件不创建接受任意路径的下载接口。

有效 UTF-8 内容以 TextEncoder 还原（保留 BOM/CRLF），base64 内容按字节解码；以 `application/octet-stream` Blob 和原始 basename 调用 `experimental_saveFile`。不做换行、编码或文件名 URL 解码。沿用 `files.read` 的现有大小限制（本基线非图片 25 MiB）；文件整个加载进内存，不提供大文件流式下载。目录、拒绝读取、host 离线和过大文件显示原 SDK 错误；保存启动失败沿用 BB toast，并在面板显示失败。卸载面板/切换文件时取消未完成读取。

BB SDK 声明浏览器/桌面使用下载，iOS shell 使用系统分享面板；移动浏览器由自身下载行为决定。真实浏览器、桌面和 iOS 保存行为尚待安装验收。

## 开发与验收

集合 bb-runtime.json 与本插件统一使用 BB `fork-v0.47.0-20261029.1`，本插件锁定对应公开 SDK tarball（0.6.75）；其他插件的 SDK 不变。不能用同号但接口不同的上游包替代。标准 CI 经 fetch-runtime.mjs 获取校验过的 runtime，然后 verify.mjs ci/typecheck/test/build 串行覆盖全部成员。重型任务获串行资源后，在本目录执行：

```sh
export BB_PLUGINS_RUNTIME_DIR=/path/to/bb-fork-v0.47.0-20261029.1
node ../../scripts/runtime-toolchain.mjs npm ci --no-audit --no-fund --legacy-peer-deps
node ../../scripts/runtime-toolchain.mjs npm run typecheck
node ../../scripts/runtime-toolchain.mjs npm test
node ../../scripts/runtime-toolchain.mjs bb plugin build .
```

所有检查应在宿主资源隔离 scope 中运行。`package-lock.json` 复用集合已锁定的工具链，SDK 换为上述实际发布包的 SHA-512，补齐其新增的 TanStack 依赖及与集合 thread-search 相同的 UI 测试工具链；真实全成员冷 npmci 已核验本包 lockfile；验证固定使用 runtime 自带 Node/npm，脚本内 npm/npx 同样固定，不回退宿主全局工具链。

已在固定 runtime 上完成真实冷安装、types/tests/build 与集合 lint/format/audit/隔离迁移；13 个行为夹具覆盖原始字节、host/root 选择、非法路径、错误传播，以及默认预览、预览 DOM/状态保留、防重复、失败重试和取消迟到下载。根 runner 另有 5 项命令编排夹具，验证十个成员的冷安装/types/tests/build 接入、失败传播、runtime 来源拒绝、缺少npm时报错和嵌套npm/npx继承；它们之外的真实冷安装和构建也已执行。错误夹具验证传播，不代表实测了服务端拒绝策略。真实 bundle 已生成，目标实例插件安装和 live UI 验收仍待执行。

安装后须验收：截图对应菜单入口；中文空格 HTML 下载后比较 SHA-256；两台 host 同路径不同内容；环境/线程存储；不存在、离线、越界符号链接与 25 MiB 限制；重复点击、关闭面板及禁用插件；桌面浏览器、窄屏移动浏览器和原生 shell。保留既有插件的 enabled、配置和数据。
