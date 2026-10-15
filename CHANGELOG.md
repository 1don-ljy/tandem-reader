# 更新日志

本项目自 `0.5.0` 起在此记录。更早的 `0.1.0`–`0.4.0` 只有本地 ZIP，没有条目化记录。

## Unreleased

- 修复浏览器冒烟测试 harness 的两个缺陷：fixture 以 Buffer 读入后被当成对象序列化成 JSON（导致 `/docs/observability.html` 与 `/docs/json-output.html` 返回的不是 HTML），以及 Service Worker 重启时复用了已 `detach()` 的 CDP session。24 个浏览器场景现已在本地全部通过。仅测试代码改动，扩展产物不变。

## 0.5.1

- 新增扩展图标（16 / 32 / 48 / 128），工具栏与扩展管理页不再显示默认图标；图标为几何占位设计，可按品牌替换。
- 新增 GitHub Actions：`ci.yml` 在 push / PR 时执行类型检查、单元测试与生产构建；`browser.yml` 可手动或每周运行浏览器冒烟测试，自动安装 Playwright 并上传截图。
- 浏览器测试可用 `PW_HEADED=1` 在有头模式下运行，用于无头模式无法加载扩展的环境（例如 Linux 上配合 `xvfb-run`）。

## 0.5.0

首个公开版本，也是项目更名为 **Tandem Reader** 的版本。相对 `0.4.0`：

**新增**

- 设置页「诊断」区：查看并导出最近 200 条结构化记录（时间、请求类型、任务标识、耗时、错误分类）。记录只存在后台内存、只复制白名单字段，不含页面原文、译文或 API Key。
- 开发构建 `npm run build:watch`：监听源码持续重建，仅开发构建生成 sourcemap。
- 打包预检：`npm run package` 会校验 manifest 版本与 `package.json` 一致、产物中无 sourcemap、无测试文件。
- 单元测试覆盖存储迁移的幂等性与诊断环形缓冲；浏览器冒烟测试拆成独立场景。

**变更**

- 项目更名：包名 `document-translator-extension` → `tandem-reader`，扩展名与各界面文案改为 `Tandem Reader`，导出文件名改为 `tandem-reader-*.json`，ZIP 名改为 `tandem-reader-<version>.zip`。
- 版本号单一来源：`public/manifest.json` 使用 `__VERSION__` 占位符，构建时从 `package.json` 注入。
- 单元测试直接用 Node 类型剥离运行 `src/**`，不再需要先构建。
- 工程重构（不改变用户可见行为）：拆分三个入口大文件、Shadow DOM 样式移到 `toolbar.css`、消息协议集中到 `src/shared/protocol.ts`、content 状态改为判别联合 `RunState` + `RunToken`、存储迁移改为有序幂等迁移表。
- 修复：旧格式缓存清理在扩展已迁移过但格式标志不匹配时会被跳过；保存模型配置时读取了一个响应中不存在的字段。

**已知限制**

- 尚未在真实浏览器中运行拆分后的冒烟测试（需要自行安装 Playwright 后执行 `npm run test:browser`）。
- manifest 未声明 `icons`，提交扩展商店前需要补图标、商店文案/截图与隐私政策页。
