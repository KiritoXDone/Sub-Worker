# Sub-Worker

在 Cloudflare Workers 免费计划上运行 Sub-Store 核心工作流的架构与本地验证仓库。

当前阶段：**架构设计 + 999 节点本地原型**。不是已经完成生产验收的部署包，尚未向 Cloudflare 部署。

- 数据与转换放在 SQLite Durable Object；入口 Worker 保持轻量。
- 复用 Sub-Store 的解析和输出逻辑。
- QuickJS-WASM 执行动态脚本，增加有预算的 HTTP 桥接与明确的错误传播。
- 逐节点网络查询通过持久化检查点与 Alarm 分批处理。
- 下载优先读取已生成的输出，避免每次重新解析 YAML 和执行脚本。

架构、接口与实施顺序见 `docs/ARCHITECTURE.md` 和 `docs/IMPLEMENTATION.md`。测量方法、结果与不能由本地证明的事项见 `docs/BENCHMARKS.md`。

## 本地复现

本次验证使用 Node.js 26.8.1、pnpm 11.25.0；依赖要求至少 Node.js 22.19.0。复现建议使用已测试版本：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run setup:vendor
pnpm run bench
```

测试固定使用 999 个虚构节点（SS、Trojan、VLESS 各 333 个）。所有外部 HTTP 由本地 fixture 处理，不读取真实订阅、不连接真实节点，也不需要 Cloudflare 凭据。

结果写入 `bench/results.json`、`bench/cache-results.json` 和 `bench/job-results.json`，本地 SQLite 状态分别位于 `bench/state/` 和 `bench/job-state/`。这些运行产物不提交。已整理的测量快照放在 `evidence/`。

`bench/` 包含调试路由、固定测试路径和模拟网络，仅供本地实验。不要将基准入口部署到公网。生产入口与管理鉴权按照实现计划单独建设。

## 来源与许可证

AGPL-3.0。上游与固定提交见 [THIRD_PARTY.md](THIRD_PARTY.md)。公开仓库是独立项目，保留所复用代码的许可证和来源信息。
