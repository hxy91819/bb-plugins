# File Download

插件 ID 和集合安装名均为 `file-download`，保留既有安装与文件打开器偏好的兼容性。

打开文件后直接呈现 BB 的 Original 原生预览，不再添加顶部 Download 按钮或重复文件路径。需要下载时，点击原生预览右上角的三个点，选择 **Download**。插件不再自行读取或保存文件，下载能力与限制由 BB 原生预览提供。

已有 **Open with → Download** 入口继续打开原生预览。支持的打开器扩展名仍为 `html`、`htm`、`txt`、`md`、`json`、`csv`、`pdf`、`zip`。插件没有配置、存储、后台服务或新增 HTTP 路由。

## 开发

按集合 `bb-runtime.json` 使用固定 runtime，在宿主资源隔离 scope 中运行：

```sh
export BB_PLUGINS_RUNTIME_DIR=/path/to/pinned/runtime
node ../../scripts/runtime-toolchain.mjs npm ci --no-audit --no-fund --legacy-peer-deps
node ../../scripts/runtime-toolchain.mjs npm run typecheck
node ../../scripts/runtime-toolchain.mjs npm test
node ../../scripts/runtime-toolchain.mjs bb plugin build .
```
