<div align="center">

<div style="padding:8px;border-radius:100%;background:white;width:124px;height:124px">
<img src="https://cdn.ocsjs.com/resources/img/logo.png" width=124 height=124  >
</div>

# OCS Plus 网课助手

> 基于 OCS 的可扩展网课助手。

![GitHub Repo stars](https://img.shields.io/github/stars/broken-star1999/ocsjs-plus)
![License](https://img.shields.io/github/license/broken-star1999/ocsjs-plus)

</div>

## Plus：AI 答题

支持直接调用 OpenAI 兼容的 Chat Completions 接口，开启后替代原有题库查询。
新增提供商时，可通过可搜索的卡片选择 DeepSeek、MiMo、OpenAI 或自定义服务。可同时管理多个提供商，连接、已配置模型和当前答题模型分别保存。

### 安装与配置

1. 在脚本猫或 Tampermonkey 中安装构建生成的 `dist/ocs.user.js`。使用时关闭原版 OCS，避免两个脚本同时操作页面。
2. 打开网课页面，在 **通用 → 全局设置** 中开启 **使用 AI 替代题库**。
3. 点击 **管理提供商与模型**。可编辑默认 DeepSeek 源，或点击 **＋ 新增** 选择供应商卡片。DeepSeek、MiMo 和 OpenAI 自动预填官方接口地址；自定义可填写兼容服务或自建网关地址，再填写名称、API Key 和超时。
   选择卡片后，未保存的提供商会立即出现在左侧，重复名称自动编号。点击右上角 **保存配置** 或 **保存并获取模型** 后才会保存；也可 **放弃新增**，切换或关闭时会提示处理未保存的修改。
4. 点击 **保存并获取模型**。获取结果先进入 **候选模型**，点击 **添加** 后才成为 **已配置模型**。不支持 `/models` 的接口可使用 **手动添加模型**。
5. 在模型行点击 **用于答题**，或回到全局设置的 **答题模型** 下拉框选择。模型行的 **测试** 会调用一次对应服务。
6. 重新开始答题或刷新课程页面，使当前任务使用新配置。默认答案提交方式为 **自动保存（不提交）**，可在全局设置自行调整。

模型列表读取服务的 `/models` 接口，并优先使用其显示名称与图片能力信息。DeepSeek 的请求格式依据
[官方入门文档](https://api-docs.deepseek.com/quick_start/agent_integrations/)、
[模型列表](https://api-docs.deepseek.com/api/list-models/)及
[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)实现。

### 当前行为与限制

- 单选、多选、判断与填空沿用平台题目提取与填写流程；AI 返回结构化答案，原生答题器仅在选项明确匹配或填空数量一致时填写。
- 图片题需在模型的 **编辑 → 允许图片输入** 中启用，同时开启 **高级设置 → 图片题优化**，并使用支持图片的模型。通过候选列表添加时会读取服务声明的图片能力；可在编辑中手动调整。
- 推理内容 `reasoning_content` 不用于填答案；格式错误、拒答、不确定、截断、超时及 HTTP 错误会显示原因。
- 提供商使用稳定内部 ID，名称可修改；即使两个提供商使用同一地址，也分别保存密钥。地址改变后不会把旧地址的密钥转发到新地址。密钥不进入普通配置和答题结果，脚本管理器完整备份仍可能包含存储值。
- 获取列表失败或刷新列表不会删除已配置模型。禁用、删除当前模型或其提供商后，会清空答题选择，不会自动换用其他服务。
- 每个模型可配置显示名称、启用状态、图片能力和额外请求参数（JSON 对象）。支持 `temperature`、`max_tokens`、`reasoning_effort`、`thinking` 等参数，不允许覆盖题目消息、模型 ID 或流式传输方式。
- 旧版单接口配置在升级后自动迁移为一个提供商，保留原先选中的模型及密钥。候选模型不会在迁移时全部启用。
- 请求只将题干、选项及启用识图时的题目图片发送至所填 AI 服务。AI 模式跳过原有按题干索引的题库缓存，重复答题可能再次调用接口。
- 兼容不等于正确率保证；真实课程页面仍受上游平台适配情况影响。当前通过模拟接口测试和本地界面验证，真实 DeepSeek 生成需配置有效密钥后验证。
- 关闭 **使用 AI 替代题库** 后可以使用原题库配置。

### 本地开发与验证

```sh
# Node.js 18+，pnpm 版本由 packageManager 指定
pnpm install --frozen-lockfile
npm test
npm run build

# 按提供商分别模拟配置界面，不发送外部 AI 请求
npm run preview:ai
```

预览地址为 `http://127.0.0.1:4179`。用户安装包统一为 `dist/ocs.user.js`，保留 `@connect *` 以支持任意 AI 接口域名；另生成更新元信息、开发入口及内部构建文件。
构建无需填写任何 AI 密钥。预览页用模拟响应验证操作流程，DeepSeek、MiMo、OpenAI 和自定义地址返回各自的模拟模型，页面与模型名称均标注“模拟”；这些示例不能用于确认真实服务的可用模型或连通性。`http://127.0.0.1:4179/?legacy=1` 可查看旧版配置迁移效果。

## OCS Plus 更新

更新模块仅查询本仓库的 GitHub 正式 Release，更新日志使用该 Release 的正文。没有正式版本时显示“尚未发布”；文件未上传完整、网络失败和 GitHub 限流会分别提示，不会回退到上游源。

主安装包的 `@updateURL` 和 `@downloadURL` 分别指向本仓库最新正式 Release 的 `ocs.meta.js` 与 `ocs.user.js`。当前脚本名称、namespace 和配置存储方式保持一致；开发入口不设置正式更新地址。更新通知默认关闭，开启后可跳过某版本或当天不再提示，点击更新后由脚本管理器完成安装。

仓库地址统一配置在 `packages/scripts/src/config/plus-repository.json`。发布流程读取已审核标签，检查标签版本与 `package.json` 一致，测试和构建通过后上传主脚本及元信息。推送、打标签和正式发布需要维护者明确审核；本地构建不会创建 Release。

本地更新面板验证：在预览地址后添加 `?updates=none`、`?updates=ready`、`?updates=pending` 或 `?updates=error`，分别模拟尚未发布、有完整新版、文件未就绪与 GitHub 限流。模拟新版仅用于验证界面，不是已发布版本。

## 上游项目及文档

本项目 Fork 自 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)，保留原作者署名及 [MIT 许可证](LICENSE)。

上游使用文档：[https://docs.ocsjs.com](https://docs.ocsjs.com)。Plus 版本的新增功能与原版可能有所不同。
