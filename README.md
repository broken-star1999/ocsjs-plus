# OCS Plus 网课助手

基于 [OCS](https://github.com/ocsjs/ocsjs) 扩展的网课助手。保留原版课程适配与自动答题流程，提供 AI 模型接入、多模型联合答题、人工评判和单题重做。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Verify OCS Plus](https://github.com/broken-star1999/ocsjs-plus/actions/workflows/verify-plus.yml/badge.svg?branch=feat%2Fai-answerer)](https://github.com/broken-star1999/ocsjs-plus/actions/workflows/verify-plus.yml)

[安装最新正式版](https://github.com/broken-star1999/ocsjs-plus/releases/latest/download/ocs.user.js) · [版本与下载](https://github.com/broken-star1999/ocsjs-plus/releases) · [更新日志](CHANGELOG.md) · [问题反馈](https://github.com/broken-star1999/ocsjs-plus/issues) · [原版文档](https://docs.ocsjs.com)

## 功能

| 模块 | 能力 |
| --- | --- |
| AI 接入 | 使用 OpenAI 兼容的 Chat Completions 接口，支持官方服务、中转网关和本地服务 |
| 提供商管理 | 内置 DeepSeek、MiMo、OpenAI 与自定义入口，独立管理地址、密钥、超时和模型 |
| 模型管理 | 获取候选模型列表，手动添加模型，配置显示名称、启用状态、图片能力和额外请求参数 |
| 普通模式 | 每道题使用所选模型作答一次 |
| 高级模式 | 多模型并行作答或单模型同题多次作答，分别设置参与模型和请求次数 |
| 决策与人工处理 | 主客观题独立配置，支持候选对比、采用、定位、重试和待人工队列 |
| 图文搜题 | 提取网页选区中的文字与图片，提供图片预览、移除和发送前检查 |
| 单题重做 | 在已接入的页面中重新查询并替换指定题目的答案，保留其他题目结果 |
| 调用详情 | 展示提供商、模型、耗时、图片数量、Token 用量及接口返回的思考内容 |
| 窗口适配 | 主悬浮窗限宽，长题目换行、图片缩放，小窗口下调整表单和按钮布局 |
| 题库兼容 | 关闭 AI 后使用原有题库查询与匹配流程 |

课程平台适配沿用 OCS，包括超星学习通、知到智慧树、职教云、智慧职教、中国大学 MOOC、雨课堂等。AI 接口接入与课程平台适配独立维护，具体功能由对应页面适配器提供。

## 安装

1. 安装 Tampermonkey（油猴）或脚本猫。
2. 打开 [最新正式版安装入口](https://github.com/broken-star1999/ocsjs-plus/releases/latest/download/ocs.user.js)，在脚本管理器中完成安装。
3. 打开支持的课程页面，通过 OCS Plus 悬浮窗进入 **通用 → 全局设置**。

安装文件为 `ocs.user.js`。`ocs.meta.js` 用于版本检测，`ocs.dev.user.js` 用于本地开发；GitHub 自动生成的源码压缩包不作为脚本安装包。

主安装包使用 `@connect *` 连接自定义 AI 接口，脚本的运行页面由课程平台匹配规则决定。安装时应避免同一页面上多个自动答题脚本同时操作。

## 配置 AI

### 提供商与模型

在 **全局设置 → 管理提供商与模型** 中配置：

1. 点击 **新增**，选择提供商卡片。
2. 填写名称、API Key、API Base URL 和超时。
3. 点击 **保存并获取模型**，将需要的候选模型添加到已配置模型。
4. 启用模型，并在全局设置中选择普通模式模型或配置高级模式。
5. 开启 **使用 AI 替代题库**，可先通过模型行的 **测试** 检查连接，再开始答题。

不提供模型列表的服务可通过 **手动添加模型** 配置模型 ID。提供商配置支持草稿，保存后生效；模型测试使用实际配置的服务。

| 提供商 | 预设地址 |
| --- | --- |
| DeepSeek | `https://api.deepseek.com` |
| MiMo | `https://api.xiaomimimo.com/v1` |
| OpenAI | `https://api.openai.com/v1` |
| 自定义 | OpenAI 兼容接口地址 |

API Key 保存在脚本管理器存储中，按提供商与接口地址隔离。题干、选项和启用的题目图片会发送到配置的 AI 服务；本地免密服务可以留空密钥。

### 作答模式

**普通模式**使用一个模型对每道题作答一次。

**高级模式**通过主设置界面旁的 **高级模式设置** 打开。参与模型可以分别设置同题请求次数，既支持多模型联合答题，也支持单模型多次作答。原有答题线程数控制同时处理的题目数量，两项设置共同决定请求并发量。

客观题与主观题分别配置处理方式：

| 题目类别 | 处理方式 |
| --- | --- |
| 客观题 | 人工处理、全部一致、一致率阈值、总结模型，以及一致率与总结模型的先后组合 |
| 主观题 | 人工处理、采用指定参与模型的答案、总结模型 |

一致率表示多次回答的一致程度。主观题不使用一致率选择。总结模型接收题目及各次回答信息；失败或未满足规则时，结果进入对应的人工处理流程。

### 图片题

图片输入需要同时开启 **全局设置中的图片题优化** 和模型的 **允许图片输入**，并使用实际支持图片输入的服务。

脚本将图片转换为 Base64，与题干和选项一起发送。在 **在线搜题** 中划选网页文字或图片后，可以预览和移除图片，再点击搜索。截图、网页背景图和 Canvas 不属于该选区提取流程。

## 结果与重做

结果面板按题号展示答案、决策状态和调用详情。收起调用详情后仍保留答案；接口返回的思考内容单独展开。

待人工题可查看各次候选、定位原题和切换下一道待处理题目。采用候选与重新请求需要页面接入对应的回填适配器，并在自动处理完成后使用；其他页面可根据候选手动填写并确认。判断、选择和填空结果通过题型对应的匹配与填写流程处理。

整次任务结束后，已接入页面的结果下方会显示 **重做本题**。重做绕过答案缓存，使用原任务配置重新查询，只处理该题，不执行整卷完成或提交流程。查询或填写前校验失败时不先清空已有答案；填写过程中题目失效则停止操作，并提示核对本题。

单题重做已接入超星整卷作业／考试与新版随堂练习，支持单选、多选、文字判断和填空，包括具备图片输入条件的图片选择题。入口随平台适配器显示。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| [`packages/core`](packages/core) | AI 请求与答案解析、联合答题决策、题型匹配、任务与重做控制 |
| [`packages/scripts`](packages/scripts) | 课程平台适配、脚本界面、提供商配置、结果展示和更新入口 |
| [`packages/utils`](packages/utils) | Userscript 元信息与构建工具 |
| [`scripts`](scripts) | 构建、样式编译和发布脚本 |
| [`tests`](tests) | 自动化回归、页面夹具和本地预览 |
| [`docs`](docs) | 维护约定与开发说明 |

## 开发与测试

构建环境以 [`package.json`](package.json) 和 [CI 配置](.github/workflows/verify-plus.yml) 为准，pnpm 版本由 `packageManager` 字段指定。

```sh
pnpm install --frozen-lockfile
npm run build
npm test
```

先构建工作区包，再运行集成测试。主要安装产物为 `dist/ocs.user.js` 与 `dist/ocs.meta.js`；构建过程不需要 AI 密钥。

本地预览加载实际构建代码，并使用模拟的 AI 与更新响应：

```sh
npm run preview:ai
```

终端输出预览地址。页面提供图片选区、超宽结果、单题重做和错误响应等测试入口，可通过地址参数选择场景：

| 参数 | 场景 |
| --- | --- |
| `?search=1` | 图文在线搜题 |
| `?results=1` | 答题结果与单题重做 |
| `?ensemble=1` | 高级模式配置 |
| `?legacy=1` | 旧接口配置迁移 |
| `?updates=ready` / `long` / `empty` | 更新入口与不同长度的发布说明 |
| `?updates=pending` / `error` / `none` | 附件未就绪、请求受限和尚无正式发布 |

`npm run preview:ai-chain` 提供题目匹配、缺图拦截、总结回退及暂停／继续等链路夹具。本地模拟验证、真实服务请求和真实课程页面回填分别记录，相关结果随版本写入 [CHANGELOG](CHANGELOG.md) 或 Release。

## 维护与发布

Plus 功能在默认分支维护，上游镜像保留原版代码。功能开发与上游同步使用独立分支，通过检查后以 PR 合入默认分支。上游同步、功能合并和正式发布分别执行，具体流程见 [Fork 维护说明](docs/maintaining-fork.md)。

正式版安装与更新统一使用 [本仓库 Releases](https://github.com/broken-star1999/ocsjs-plus/releases)。脚本内更新面板读取正式发布信息，脚本管理器通过 `ocs.meta.js` 与 `ocs.user.js` 检查和安装更新；预发布版本从对应 Release 安装。

逐版改动与发布验证记录见 Release 和 [CHANGELOG](CHANGELOG.md)。

## 致谢与许可

OCS Plus 由 [broken-star1999](https://github.com/broken-star1999) 维护，基于 [enncy](https://github.com/enncy) 与 [OCS 贡献者](https://github.com/ocsjs/ocsjs/graphs/contributors) 的工作扩展，保留原作者署名与 [MIT License](LICENSE)。

原版平台功能可参考 [OCS 文档](https://docs.ocsjs.com)，Plus 的模型接入和扩展功能见本仓库文档。提供商图标采用 [LobeHub Icons](https://github.com/lobehub/lobe-icons) 的相关资源，许可声明保留在对应源文件中。
