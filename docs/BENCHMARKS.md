# 999 节点本地验证与额度判断

测试日期：2026-11-13。结论：**该规模适合以 SQLite Durable Object 承担计算和状态；解析/产物缓存能显著减少重复工作。当前仍不能宣布云端 128 MB 内存限额已验收。**

## 测试基线

- 主机：Intel Core i5-1038NG7 2.00 GHz，macOS x64；Node.js 26.8.1。
- Miniflare 4.20260730.0 / workerd 1.20260730.1，兼容日期 2026-07-30，显式开启 `nodejs_compat`。
- Sub-Store Workers 分支 2.44.2，固定提交见 `vendor/sub-store/ORIGIN.json`；不是最新上游 2.44.9 的完整移植。
- 999 个不同的虚构节点：SS、Trojan、VLESS 各 333 个。URI 135,420 字节，Base64 180,560 字节，Mihomo YAML 229,336 字节。
- 每个主场景预热 2 次，随后测量 12 次。样本较少，P95 仅作观察，不作为稳定延迟承诺。
- 所有 HTTP 都由本地 fixture 响应。Geo fixture 人为等待 5 ms；没有接入真实机场、IP 信息服务或 HTTP META。

## 测量定义

CPU 列来自专用 workerd 子进程在一组请求前后的 macOS `ps` 累计 CPU 差，除以请求数。计时分辨率 10 ms，包含本地 workerd、SQLite 等开销，不含 Node 测试程序；不是 Cloudflare 单请求计费 CPU，也不能区分入口 Worker 与 DO 各自的 CPU。

耗时列是本机端到端 wall time，包含等待，不能当作 CPU。日志输出被关闭，脚本和 SQL 另有测量插桩。缓存 GC 诊断在测量批次结束后执行，不计入该批 CPU 差。

内存使用 CDP 堆快照、QuickJS 存活对象与 WASM linear memory 快照；RSS 只记录为整个 workerd 进程的数据，不拿来直接与 isolate 128 MB 比较。

Cloudflare 明确说明配置的限额只在云端强制执行，[本地不强制这些限额](https://developers.cloudflare.com/workers/wrangler/configuration/#limits)。本地成功既不是“通过 10 ms”，也不是“通过 128 MB”。本次 runtime 也早于当前生产日期，最新平台行为以官方文档和将来的云端验收为准。

## 本地结果

以下为主测量快照的近似值；缓存补充场景的逐次数据见 evidence 文件。

| 场景：均为 999 节点 | workerd 进程 CPU/请求 | 端到端中位耗时 | 每次外部 HTTP |
| --- | ---: | ---: | ---: |
| URI → JSON | 153 ms | 163 ms | 0 |
| URI → Mihomo | 147 ms | 151 ms | 0 |
| Base64 → Mihomo | 141 ms | 144 ms | 0 |
| YAML → Mihomo | 305 ms | 253 ms | 0 |
| 3 个内置操作 | 178 ms | 180 ms | 0 |
| 1 个 QuickJS 脚本 | 234 ms | 234 ms | 0 |
| 3 个 QuickJS 脚本 | 328 ms | 330 ms | 0 |
| QuickJS + 1 次 HTTP | 245 ms | 265 ms | 1 |
| 3 个来源，已缓存 | 308 ms | 289 ms | 0 |
| SQLite 归一化节点 → Mihomo | 约 13 ms | 约 16 ms | 0 |
| SQLite 完整产物直接读取 | 5 ms | 8 ms | 0 |
| 3 个来源，强制实际请求 | 约 254 ms | 约 268 ms | 3 |

普通免费 Worker 的 10 ms 预算不适合作为这些完整转换链路的设计目标。DO 默认 CPU 限制为 30 秒，本地最重的三脚本场景约 0.33 秒，提供了明显的可行性余量，但两者不是同一种线上计量。[Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)；[DO 限额](https://developers.cloudflare.com/durable-objects/platform/limits/)

缓存效果应看差距很大的路径：归一化缓存约 13 ms，完整产物读取约 5 ms。接近的场景受主机调度、GC 与插桩影响，不能从单次表格断言来源缓存一定比重新请求更慢或更快。

构建的实验 JS bundle 约 1.48 MB，另有约 0.50 MB 的 QuickJS WASM。主测试 SQLite 快照约 0.73 MB，网络作业数据库约 40 KB。数据库大小随已跑过的场景变化，包含测试表，不是云端计费存储的精确预测。

## 内存观察

- 最终主测量中，YAML 场景批次后的 JS heap 约 94.6 MB，主动 GC 后约 8.9 MB。
- 较早一轮连续测试、没有批次间 GC 诊断时，YAML 场景后的快照曾达到约 **238 MB**，见 `evidence/initial-memory-observation.json`。
- 普通/脚本场景 GC 后 JS heap 约 7～9 MB。
- QuickJS 存活 guest 对象约 0.9 MB；WASM linear memory 为 **16 MiB**。guest 对象占用属于 WASM 内存的一部分，不能把两个数再次相加。V8 heap/backing storage 与 WASM 的统计边界也不能简单相加当成 isolate 峰值。

这些结果更符合“大量临时分配”而非仅凭一次快照就能确认的持久泄漏；**它仍是实际内存风险，不能用 GC 后的小数字消掉。** 生产不能依赖测试用的主动 GC。实现应按内容摘要复用解析结果，限制内存缓存和输入字节数，串行执行重计算，并在云端测真实峰值。

## 网络分批与恢复

999 个不同查询由 DO 以 40 条/批、并发 4 处理：

- 总共 **25 批、999 次 HTTP**，每一批都不超过 40 次。
- 前两批处理 80 个节点后重启 workerd，恢复 cursor=80，余下 919 个继续通过 Alarm 完成。
- 冷查询批次合计约 **2,048 行读、1,049 行写**，包含原型的进度与批次记录；启动/轮询/平台内部元数据开销另计。
- 第二轮 999 个查询全部命中缓存，HTTP 为 **0**；原型仍走 25 个小批次，合计 1,049 行读、50 行写。生产调度可根据过期时间跳过这些无效唤醒。
- 本地最大并发确认为 4。总耗时使用了 5 ms 模拟网络，不能当成真实 IP 服务速度。

普通脚本尝试自行顺序调用 999 次 HTTP 时，在 40 次后明确返回 422 / `HTTP_BUDGET_EXCEEDED`。它不会被自动变成可恢复作业；批量查询需要结构化预处理任务。

## 功能检查

- 全部转换场景输出 999 个不同服务器，脚本修改后的名称符合预期。
- 归一化缓存输出与原转换输出逐字节相同。
- 真实调用计数验证冷/热缓存，不根据参数名推断是否发生网络请求。
- 宿主和 guest 的 `Date.now()` 都冻结时，无限循环仍被回调预算中断，API 返回明确错误。
- 两次并发 patch 的不同字段都保留。
- workerd 进程重启后，SQLite 数据与脚本输出恢复。
- Alarm 作业中途重启恢复；缓存再次运行无外部请求。

脚本样本均明确声明 `operator`；没有覆盖旧脚本的所有入口探测/回退形式，也未验收不 await 的宿主 I/O、所有二进制类型或任意嵌套脚本。原型的错误传播钩子需在生产实现中区分入口探测失败和实际执行失败。

测试还定位了非 Node 下载 Map 的作用域问题：在持久 DO 中，它会先于 TTL/强制刷新判断命中旧结果。原型把它改成每请求 Map。该修改是迁移正确性要求，不只是性能优化。

## 免费额度模型

截至检查日期，官方 Free 额度包括：普通 Worker 100,000 请求/日；DO 100,000 请求/日、13,000 GB-s/日、5,000,000 行读/日、100,000 行写/日、5 GB 总存储。普通 Worker 的外部子请求每调用 50 次，DO 还受其适用的平台限制。[Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)；[DO 定价](https://developers.cloudflare.com/durable-objects/platform/pricing/)

用一个明确的示例负载估算，**不是用户已提供的实际使用量**：

- 1,000 次下载/日，3 个来源，每小时刷新一次产物。
- Geo 999 个不同地址，TTL 24 小时，每日一次冷刷新。
- 不计管理操作时，约 1,000 次下载 + 24 次刷新 + 25 个 Geo 批次，即约 1,049 次业务 DO 调用/日，远低于请求额度。
- Geo 冷刷新约 1,049 行写，约为每日写额度的 1%；再加配置、来源和产物写入也有明显余量。实际索引、重试和内部元数据需要线上观察。
- 来源约 72 次 HTTP/日，Geo 999 次/日；这些请求按批次控制，不能把 1,071 次合并成一个调用。第三方服务自身的限制不属于 Cloudflare 额度。
- DO duration 按存活且计费的 wall time与分配的 128 MB 计量，不按实际 guest 内存或本地 CPU 来算。若为这一示例预留每日 2,000 秒计费活跃时间，约为 **256 GB-s**，约占 13,000 GB-s 的 2%。这是预算情景，不是已观测账单。

所以：对于个人 999 节点量级，请求数、存储与每日行写入通常不是主要障碍；计算放 DO，网络分批，避免重复 YAML 解析后，免费路线有依据。**云端内存峰值、实际 CPU 和源站网络可达性仍是发布前的验收项。**

## 证据文件

- `evidence/local-results.json`：主测试、逐次样本、环境和功能检查。
- `evidence/cache-results.json`：归一化缓存和强制网络请求验证。
- `evidence/job-results.json`：25 批 Alarm、检查点恢复和缓存结果。
- `evidence/initial-memory-observation.json`：早期未主动 GC 的堆快照。

以上文件均不包含真实订阅、真实节点密码或 Cloudflare 凭据。
