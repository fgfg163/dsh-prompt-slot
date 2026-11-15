# @fgfg163/dsh-prompt-slot

[English](README.md) | 简体中文

> DeepSeek Harness 的公共每轮注入插槽。名字对应 OpenClaw 的 `before_prompt_build` hook。
> 2026-11-15 从 `dsh-prompt-inject` 更名并加作者前缀，服务名 `ctx.promptInject` 保持不变。

给 DeepSeek Harness 加一个**公共的每轮注入插槽**：别的插件往这个插槽里写内容，每轮都能不同，而且**不吃 KV cache 前缀**。

对应 OpenClaw 的「注入位置」需求，但 DSH 的模型不同，所以实现也不同。

## 为什么不能直接用现成的 API

DSH 有四个能往模型可见历史里放文字的地方，缓存代价差一个量级：

| 位置 | API | 落地形态 | 缓存代价 |
|---|---|---|---|
| 系统提示词段 | `ctx.systemPrompt.section()` | 重写 surface 第 0 号 system 节点 | **从第一个变化的 token 起全丢** |
| 动态运行时事实 | `ctx.systemPrompt.context()` | 一条 user 快照，**原位替换** | **从替换点起丢**（替换点常在历史中间） |
| pre-step 追加 | `agent/pre-step` → `decision.messages` | 追加一条 user/message | **不丢**，纯 append |
| 工具后追加 | `post-execute` 的 `additionalContexts` | 工具结果之后追加 | 不丢 |

官方 `dsh-time-context`、agentmemory 捕获插件、`dsh-repeat-tool-reminder` 走的都是后两种，README 原话是「仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效」。

**但后两种没有「位置」**：每个插件各自往 `decision.messages` 里 push，顺序取决于注册顺序，没有公共插槽、没有预算、没有去重，也没法把一个位置交给别的插件用。

本插件补的就是这一层。

## 它做什么

- 提供 `ctx.promptInject` 服务，任何插件都能注册一个 slot
- **两条通道**：`channel: 'pre-step'` 追加进会话历史（默认）；`channel: 'request'` 只进发给模型的请求，**不写日志**
- 每轮第一步，把已注册 slot 的文本合成**一条** user 消息
- 与持久 session projection 比对，**同一轮同样内容不重复注入**（恢复会话也成立）
- 严格预算：单 slot 上限 + 总量上限，超了按优先级淘汰
- 渲染有超时，坏 slot 跳过并记日志，**绝不让一轮对话卡死**
- 绝不碰 system prompt、绝不碰 runtime-context 快照

## 两条通道的区别

| channel | 落地 | 进会话历史 | 能事后从日志重建 |
|---|---|---|---|
| `'pre-step'`（默认） | `agent/pre-step` → `decision.messages` | 是 | 是 |
| `'request'` | `llm/stream` 里改写后的出站请求 | **否** | **否** |

`'request'` 是 OpenClaw `prependContext` 的语义：文本插在本轮用户消息之前，只对这一次模型调用可见。

**代价必须写清楚**：`dsh-llm/README.md` 的不变量是「Model-visible ⟺ logged」（模型看得见的必须能从日志重建）。`'request'` 主动破坏这条——排障时要知道模型看过 `session.v4.jsonl` 里没有的东西。

实现上它绕不开一个硬约束：cordis 的 `waterfall` 里 `next()` 是固定用原始参数的闭包，所以**不能** `next(新参数)`，只能不调 `next`、自己重入 `ctx.llm.stream(新请求)`，并用 `WeakSet` 标记新对象防止无限递归。副作用是 `prepareCall()` 的绑定会重做一次，每步多一次 adapter 预解析。

`llm/stream` 会看到标题生成、压缩摘要这类辅助调用，它们都带 `options.purpose`，必须 `if (options.purpose !== undefined) return next()` 放过。

## 装

把 `dsh-prompt-slot/` 放进 profile 的 `node_modules`，然后在 profile 的
`cordis.patch.yml` 里 insert 一行（绝对路径会被加载器转成 `file://`）：

```yaml
- insert:
    - id: fgfg163-prompt-slot
      name: '@fgfg163/dsh-prompt-slot'
      config:
        position: before      # before | after
        totalMaxChars: 8000
```

也可以做成 bundle 包进 `package.json` 的 `dsh.profile.bundles`，本仓库自带
`cordis.patch.yml` 走这条路。

### 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `position` | `'before'` | 仅对 `'pre-step'` 通道有效：`before` 放在本轮用户输入之前（OpenClaw prependContext 语义）；`after` 放在所有已有消息之后 |
| `totalMaxChars` | `8000` | 一次注入合并后的总字符上限（两条通道各自独立计） |

`runtime-context` 快照永远不会被挤走：`before` 时插槽落在第一个**非** runtime-context 消息之前，保持循环对它位置的预期。

### slot 字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `id` | 必填 | 全局唯一；重复注册抛错，不静默覆盖 |
| `render` | 必填 | 返回字符串；`null`/`undefined`/空串 = 本轮不注入。可以是 async |
| `channel` | `'pre-step'` | `'pre-step'` 写历史 / `'request'` 只发模型 |
| `priority` | `100` | 越小越靠前 |
| `when` | `'turn'` | `'turn'` 每轮第一步 / `'step'` 每个模型步骤。`'request'` 通道目前只在 `step === 1` 渲染 |
| `maxChars` | `4000` | 单槽上限，超出截断并加标记 |
| `timeoutMs` | `1500` | 渲染超时，超时该槽跳过 |


## 用（别的插件怎么投稿）

```js
const name = 'my-plugin'
const inject = ['promptInject']   // 依赖插槽服务，等它就绪

function apply(ctx) {
  ctx.effect(() => ctx.promptInject.register({
    id: 'my-plugin:status',        // 全局唯一；重复注册会抛错，不静默覆盖
    channel: 'pre-step',           // 'pre-step' 进历史 | 'request' 只发模型
    priority: 100,                 // 越小越靠前
    maxChars: 1000,                // 单槽上限，超出会截断并加标记
    when: 'turn',                  // 'turn' 每轮第一步 / 'step' 每个模型步骤
    timeoutMs: 800,                // 渲染超时，超时该槽跳过
    render: ({ turn, step, agent, session, decision, signal }) => {
      return `stale jobs: 3`       // 返回字符串；null/undefined/空串 = 本轮不注入
    },
  }), 'my-plugin.register()')
}
```

`render` 可以是 async。拿到的上下文：

| 字段 | 含义 |
|---|---|
| `turn` / `step` | 当前轮次与步骤 |
| `agent` / `session` | agent 与 session 对象 |
| `decision` | 下游 pre-step 的原始决策（可读已有 messages） |
| `signal` | 轮次 AbortSignal，取消后不要再渲染 |

服务上还有 `unregister(id)`、`has(id)`、`list()`。`list()` 返回按最终注入顺序排列的描述符，不含函数，可直接做诊断输出。

### 缓存注意

render 返回**每轮都变**的内容是安全的（纯 append）。但请不要在 slot 里塞大段稳定文本 —— 那属于 `systemPrompt.section()`；插槽的设计目的就是「变的东西」。

## 验证

```powershell
# 单元测试（假 ctx，34 项）
node --test test\index.test.js

# 真实 Cordis 内核集成测试
node test\integration.mjs
```

单元测试覆盖：位置、runtime-context 不被挤走、空首步不制造工作、reject 透传、同轮去重、
跨轮再注入、`when` 语义、优先级排序、单槽截断、总量淘汰顺序、抛错/超时隔离、
重复 id 拒绝、注销生效；request 通道另覆盖：不写历史、插入锚点、每轮一次、
辅助调用放行、防重入、单槽失败隔离。

集成测试用真实 `@deepseek-ai/cordis` 跑 `ctx.plugin()` + `ctx.effect()` + `inject` 门控 + waterfall，
确认服务真的挂上、demo 真的通过依赖门控投稿、注入内容真的落在用户输入之前。

## 已知限制

- **`'request'` 通道破坏「日志即请求」**：注入内容无法从 `session.v4.jsonl` 重建。这是刻意的取舍，不是 bug。
- **`'request'` 通道会重做 `prepareCall()`**：`waterfall` 的 `next()` 不能传新参数，只能重入 `llm.stream()`，每次改写多一次 adapter 预解析。
- **`'request'` 通道每轮只注入一次**，在 `step === 1` 渲染、被本轮的第一次模型调用消费。同轮的后续步骤（工具续跑）看不到这段记忆，但它已经在本轮上下文的末尾，模型仍然读得到。
- **只在 `agent/pre-step` 出手**，不做工具后注入。需要「工具执行完再补一句」的场景请用 `post-execute` 的 `additionalContexts`，本插件不覆盖。
- **去重按「轮次 + 正文」**：同一轮里正文变了就再注入一条，这是刻意的（内容不同就是新信息）。仅 `'pre-step'` 通道有去重；`'request'` 通道不落盘，无从比对。
- **不压缩旧注入**：注入的历史消息和普通消息一样靠 compaction 遮蔽，插件不额外清理。
- **`position: 'before'` 假设本轮至少有一条非 runtime-context 消息**；全空时不注入（空首步会被循环判成轮次结束，注入会导致空转）。
- **`'request'` 通道依赖目标消息形状**：它找最后一条 `role === 'user'` 且非 `runtime-context` 的消息作为插入锚点。找不到就退化为追加到末尾。
- 本插件不校验 `slot.render` 的返回值类型以外的语义，内容责任在投稿方。

## 与 OpenClaw 的对应

| OpenClaw | 本插件 |
|---|---|
| `before_prompt_build` 返回 `prependContext` | `channel: 'request'` —— 插在本轮 user 消息之前，只发模型不落盘 |
| `<!-- OPENCLAW_CACHE_BOUNDARY -->` 切 stable/dynamic | DSH 没有显式边界：stable 走 `systemPrompt.section()`，dynamic 走本插槽，靠 API 选择而非标记 |
| 单 hook 单返回值 | 多插件注册多 slot，按 priority 合并成一条消息 |

## 许可

MIT
