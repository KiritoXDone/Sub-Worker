# 第三方来源

本仓库按 AGPL-3.0 发布。

`vendor/sub-store/` 保留了 [kasumikira/sub-worker](https://github.com/kasumikira/sub-worker) 的后端源码、测试、构建配置和依赖锁文件，固定于提交 `413d06ff23d7f61201c509fc01fdda2a6c0aed1e`，版本 2.44.2。该项目派生于 [sub-store-org/Sub-Store](https://github.com/sub-store-org/Sub-Store)。原许可证保留在 `vendor/sub-store/LICENSE`；原文件中的版权和作者信息保持不变。

该快照仅作为本地验证基线，没有修改其源码。基准构建器在内存中插入测量代码、替换 QuickJS 的中断预算，并将非 Node 下载去重 Map 改为请求作用域；HTTP 桥接和失败传播位于本仓库的 `bench/` 中。

最新上游检查版本为 2.44.9，提交 `196a6d56db75e10942d6338ecf90f7dce65ec5c1`。本仓库尚未完成将该版本与适配基线合并，不能宣称与最新上游功能完全一致。

QuickJS / quickjs-emscripten、Cloudflare workerd / Miniflare 及其他 npm 依赖遵循各自许可证；版本由相应 pnpm 锁文件记录。
