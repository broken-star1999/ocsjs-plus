# OCS Plus 网课助手

基于 [OCS](https://github.com/ocsjs/ocsjs) 扩展的网课助手，持续跟进原版功能与修复，加入 AI 答题和多提供商管理。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/broken-star1999/ocsjs-plus)](https://github.com/broken-star1999/ocsjs-plus/releases)
[![Verify OCS Plus](https://github.com/broken-star1999/ocsjs-plus/actions/workflows/verify-plus.yml/badge.svg?branch=feat%2Fai-answerer)](https://github.com/broken-star1999/ocsjs-plus/actions/workflows/verify-plus.yml)

[下载安装](https://github.com/broken-star1999/ocsjs-plus/releases) · [更新记录](CHANGELOG.md) · [问题反馈](https://github.com/broken-star1999/ocsjs-plus/issues) · [原版使用文档](https://docs.ocsjs.com)

## 这个版本有什么

OCS Plus 保留原版的课程适配、题目提取与答案填写流程，开启 AI 后，将原来的题库查询替换为对所选 AI 服务的请求。关闭 AI 后，仍可使用原有题库配置。

| 功能 | 说明 |
| --- | --- |
| AI 答题 | 使用 OpenAI 兼容的 Chat Completions 接口，支持配置官方服务、中转网关或本地服务 |
| 多提供商管理 | 内置 DeepSeek、MiMo、OpenAI 和自定义入口，每个提供商独立保存地址、密钥、超时和模型 |
| 模型列表 | 从接口获取候选模型，也可手动填写模型 ID；添加并启用后可选作答题模型 |
| 图片题 | 将题目图片转换为 Base64 后随题干发送，需要实际支持图片输入的模型 |
| 模型配置 | 支持显示名称、启用状态、图片能力、额外请求参数和连接测试 |
| 脚本更新 | 从 OCS Plus 自己的 GitHub Release 获取安装包与更新说明 |

原版适配范围包括超星学习通、知道智慧树、职教云、智慧职教、中国大学 MOOC、雨课堂等平台。具体页面能否正常使用，取决于现有适配与平台页面变化；新增 AI 接口不会自动增加课程平台适配。

## 安装

1. 在浏览器中安装 **Tampermonkey（油猴）** 或 **脚本猫**。
2. 打开 [OCS Plus 发布页](https://github.com/broken-star1999/ocsjs-plus/releases)，在正式版本的 **Assets** 中点击 `ocs.user.js`，由脚本管理器完成安装。
3. 关闭同一页面上的原版 OCS 或其他会自动填写答案的脚本，避免重复操作。
4. 打开支持的课程页面，进入 OCS Plus 面板配置 AI。

如果发布页暂时没有正式版本，可以按下方的本地构建步骤生成 `dist/ocs.user.js`。下载 GitHub 自动生成的源码压缩包不能直接安装脚本。

对普通用户，安装 **`ocs.user.js` 一个文件** 即可。`ocs.meta.js` 用于检查更新，`ocs.dev.user.js` 和其他构建文件用于开发。

主安装包使用 `@connect *`，允许连接自行配置的 AI 接口域名；脚本运行页面仍由课程平台的匹配规则决定。

## 第一次配置 AI

在脚本面板中打开 **通用 → 全局设置**，按以下顺序操作：

1. 点击 **管理提供商与模型**，在左侧点击 **＋ 新增**。
2. 选择 DeepSeek、MiMo、OpenAI 或自定义卡片，填写提供商名称、**API Key**、**API Base URL** 和超时。
3. 点击 **保存并获取模型**。返回的列表会显示在 **候选模型** 中。
4. 对需要使用的模型点击 **添加**，将它加入 **已配置模型**。
5. 在模型行点击 **用于答题**，也可回到全局设置，在 **答题模型** 中选择。
6. 确认 **使用 AI 替代题库** 已开启。可先点击模型行的 **测试**，检查接口能否返回答案，再重新开始答题任务或刷新课程页面。

选择提供商卡片后会先创建一个未保存的草稿，点击 **保存配置** 或 **保存并获取模型** 才会保存。切换提供商或关闭窗口时，未保存的修改会提示处理。

内置卡片预填的地址如下；它们是接口预设，不代表已经使用真实密钥完成连通性测试。

| 入口 | 默认 API Base URL |
| --- | --- |
| DeepSeek | `https://api.deepseek.com` |
| MiMo | `https://api.xiaomimimo.com/v1` |
| OpenAI | `https://api.openai.com/v1` |
| 自定义 | 自行填写 OpenAI 兼容接口地址 |

**接口没有模型列表怎么办？** 点击 **手动添加模型**，填写服务支持的准确模型 ID。获取列表使用对应的 `/models` 接口；部分服务不提供该接口，或未返回完整的模型能力信息。

**获取成功却没有可选模型？** 候选模型需要先点击 **添加**，并保持启用状态，才会出现在答题模型列表中。

测试与答题都会调用所选服务，可能产生该服务的用量费用。本地免密服务可不填写 API Key。

## 图片题怎么配置

图片题需要同时满足以下条件：

1. 在 **全局设置 → 高级设置** 中开启 **图片题优化**。
2. 在 **管理提供商与模型 → 对应模型 → 编辑** 中勾选 **允许图片输入**。
3. 所选模型和接口确实支持 OpenAI 兼容格式的图片输入。

开启后，脚本会解析题目图片为 Base64，以图片内容随题干、选项一起发送，减少远程图片防盗链带来的读取问题。模型列表声明了图片能力时会用于初始化配置，也可以手动调整。

勾选 **允许图片输入** 只是告诉脚本可以发送图片，不能给纯文本模型增加识图能力。图片未成功解析或模型未启用图片能力时，脚本会提示原因。

## 答题行为与数据

- 当前任务只使用选中的一个提供商和模型。接口失败时不会自动换用其他提供商或题库。
- AI 返回结构化答案；单选、多选、判断与填空沿用原生答题器的匹配和填写流程。格式异常、不确定或不满足匹配条件的答案不会直接填写。
- 选择题的选项匹配、填空数量校验只能检查答案结构，不能保证知识判断正确。推理字段 `reasoning_content` 不会当作答案填写。
- 默认答案提交方式为 **自动保存（不提交）**，可在全局设置中调整，使用前请核对自己的当前设置。
- 题干、选项及启用识图时的题目图片会发送到所配置的 AI 服务。AI 模式跳过原有按题干索引的题库缓存，重复答题可能再次调用接口。
- 密钥保存在脚本管理器存储中，按提供商和接口地址隔离，不写入普通配置与答题结果。修改地址不会把旧地址的密钥自动转给新地址；脚本管理器的完整备份仍可能包含密钥。
- 禁用或删除当前模型、删除其提供商后，会清空当前答题选择，需要重新选择模型。

当前已完成自动化测试、构建与本地模拟界面验证。**真实 AI 服务调用到课程页面回填的完整流程尚未实测**，各家模型的实际可用性、图片能力和答题效果需要在配置后验证。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| HTTP 401 / 403 | 检查当前提供商的密钥、权限，以及修改接口地址后是否重新填写了密钥 |
| HTTP 404 | 检查 API 地址和模型 ID；获取模型列表时出错也可能是服务未提供 `/models`，可尝试手动添加 |
| HTTP 429 | 检查服务的额度和请求频率，可降低答题线程数后重试 |
| 请求超时 | 检查网络、模型响应速度及提供商的超时设置 |
| Tampermonkey 弹出跨域授权 | 已显式声明 GitHub API 和内置 AI 服务域名；自定义接口仍可能需要首次授权。若已有拒绝记录，请在脚本管理器中核对对应域名设置 |
| 能获取模型，但测试失败 | 获取列表和生成答案是两个请求；检查模型权限、余额及额外请求参数的兼容性 |
| 图片题无法作答 | 检查图片题优化、模型的图片输入开关和实际识图能力 |
| 提示答案格式或选项不匹配 | 查看答题错误信息并核对题目；脚本不会把解释性文本直接当作答案 |
| 开发预览里模型看起来可用 | 预览使用模拟响应，只能验证操作流程，不能证明真实接口连通 |

## 与原版同步、如何更新

OCS Plus Fork 自 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)，当前版本以原版 **5.2.3** 为基线。后续持续跟进原版功能、课程适配和修复；发布前核对上游更新，合并并验证兼容性后，再构建 Plus 版本。

Plus 使用独立的 **0.x** 版本号，原版基线单独记录。已安装旧编号 `5.2.x` 测试版的用户，请手动覆盖安装 `0.2.0` 一次；管理器通常不会自动降级，之后按 `0.x` 版本正常升级。

目前没有配置自动同步上游。原版更新不会直接覆盖 Plus 功能，原版发布也不会让已安装的 Plus 自动变成原版。

用户更新从 [OCS Plus Releases](https://github.com/broken-star1999/ocsjs-plus/releases) 获取。脚本管理器的更新地址和脚本内的更新面板均指向本仓库；仅向开发分支推送代码不会产生一个可安装的新版本。

- 脚本内更新检查读取本仓库的正式 Release，更新日志使用其发布说明。
- `ocs.user.js` 与 `ocs.meta.js` 两个附件上传完整后，脚本内更新检查才提供安装入口。
- 更新通知默认开启，可选择跳过某版本或当天不再提示。脚本已配置本仓库的更新地址；自动检查与安装更新由脚本管理器控制，请在其中启用 OCS Plus 的脚本更新。
- 升级保留已保存的个人设置；默认值调整不会覆盖之前保存的间隔或通知开关。
- 没有正式版本、文件尚未就绪、网络失败或 GitHub 限流时会显示相应状态。

## 本地开发

建议使用 **Node.js 22**（与当前 CI 一致），pnpm 使用 `package.json` 中声明的 **10.30.3**。

```sh
pnpm install --frozen-lockfile
npm test
npm run build
```

构建不需要 AI 密钥。用户安装包生成在 `dist/ocs.user.js`，更新元信息为 `dist/ocs.meta.js`。

### 模拟配置界面

先完成构建，再启动预览：

```sh
npm run preview:ai
```

打开 `http://127.0.0.1:4179`。预览加载实际构建的设置界面，但拦截 AI 与更新请求并返回模拟数据，不会调用外部 AI 服务。页面和模型名称均标注“模拟”，请勿在预览中填写真实密钥。

| 地址参数 | 验证内容 |
| --- | --- |
| `?legacy=1` | 旧版单接口设置迁移 |
| `?updates=none` | 尚未发布正式版本 |
| `?updates=ready` | 新版附件完整，可显示更新入口 |
| `?updates=pending` | 新版附件尚未就绪 |
| `?updates=error` | GitHub 请求受限 |

模拟版本号和模型名仅用于验证界面，不代表真实已发布版本或服务提供的模型。

### 主要代码位置

| 路径 | 职责 |
| --- | --- |
| [`packages/core/src/core/answer-wrapper/ai.ts`](packages/core/src/core/answer-wrapper/ai.ts) | AI 请求、模型发现、密钥读取与答案解析 |
| [`packages/core/src/core/answer-wrapper/ai-providers.ts`](packages/core/src/core/answer-wrapper/ai-providers.ts) | 提供商、模型状态与旧配置迁移 |
| [`packages/scripts/src/utils/ai-provider-manager.ts`](packages/scripts/src/utils/ai-provider-manager.ts) | 提供商和模型管理界面 |
| [`packages/scripts/src/projects/common.ts`](packages/scripts/src/projects/common.ts) | 全局设置与 AI 答题接入 |
| [`packages/scripts/src/utils/plus-update.ts`](packages/scripts/src/utils/plus-update.ts) | Plus Release 查询与更新判断 |
| [`packages/scripts/src/config/plus-repository.json`](packages/scripts/src/config/plus-repository.json) | 构建与更新使用的仓库地址 |

## 致谢与许可

感谢 [enncy](https://github.com/enncy) 及 [OCS 贡献者](https://github.com/ocsjs/ocsjs/graphs/contributors) 提供原版项目。课程平台适配和原有功能的使用方法可参考 [OCS 文档](https://docs.ocsjs.com)，Plus 的 AI 配置以本 README 为准。

本项目保留原作者署名，使用 [MIT License](LICENSE)。提供商图标使用 [LobeHub Icons](https://github.com/lobehub/lobe-icons) 中的相关资源，其 MIT 许可声明保留在对应源文件中。
