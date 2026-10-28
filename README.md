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
默认接口为 DeepSeek；模型列表通过服务接口获取，名称不会固定在代码中。

### 安装与配置

1. 在脚本猫或 Tampermonkey 中安装构建生成的 `dist/ocs.user.js`。使用时关闭原版 OCS，避免两个脚本同时操作页面。
2. 打开网课页面，在 **通用 → 全局设置** 中开启 **使用 AI 替代题库**。
3. 接口默认是 `https://api.deepseek.com`。也可填写其他服务的基础地址、`/v1` 地址或完整的 `/chat/completions` 地址。
4. 点击 **设置 / 更换密钥**，在弹窗中输入自己的 API Key。保存后自动获取模型列表，也可点击 **获取 / 刷新模型列表**。
5. 在 **AI 模型** 下拉框中选择模型，点击 **发送测试题** 验证连接。测试会调用一次所选服务。
6. 重新开始答题或刷新课程页面，使当前任务使用新配置。默认答案提交方式为 **自动保存（不提交）**，可在全局设置自行调整。

模型列表读取服务的 `/models` 接口，并优先使用其显示名称与图片能力信息。DeepSeek 的请求格式依据
[官方入门文档](https://api-docs.deepseek.com/quick_start/agent_integrations/)、
[模型列表](https://api-docs.deepseek.com/api/list-models/)及
[JSON Output](https://api-docs.deepseek.com/guides/json_mode/)实现。

### 当前行为与限制

- 单选、多选、判断与填空沿用平台题目提取与填写流程；AI 返回结构化答案，原生答题器仅在选项明确匹配或填空数量一致时填写。
- 图片题需同时启用 **AI 识图** 和 **高级设置 → 图片题优化**，并使用支持图片的模型。若模型列表声明图片能力，会自动设置识图开关。
- 推理内容 `reasoning_content` 不用于填答案；格式错误、拒答、不确定、截断、超时及 HTTP 错误会显示原因。
- 密钥按接口分别保存在脚本管理器存储中，不进入源码、普通设置或结果数据。脚本管理器的完整备份仍可能包含这些存储值。
- 请求只将题干、选项及启用识图时的题目图片发送至所填 AI 服务。AI 模式跳过原有按题干索引的题库缓存，重复答题可能再次调用接口。
- 兼容不等于正确率保证；真实课程页面仍受上游平台适配情况影响。当前通过模拟接口测试和本地界面验证，真实 DeepSeek 生成需配置有效密钥后验证。
- 关闭 **使用 AI 替代题库** 后可以使用原题库配置。

### 本地开发与验证

```sh
# Node.js 18+，pnpm 版本由 packageManager 指定
pnpm install --frozen-lockfile
npm test
npm run build

# 本地模拟 DeepSeek 的配置界面，不发送外部 AI 请求
npm run preview:ai
```

预览地址为 `http://127.0.0.1:4179`。构建输出包含正式、调试和全域名版本用户脚本；
构建无需填写任何 AI 密钥。服务需提供 OpenAI 格式的模型列表；不提供 `/models` 的服务暂不能在下拉框中使用。

## 上游项目及文档

本项目 Fork 自 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)，保留原作者署名及 [MIT 许可证](LICENSE)。

上游使用文档：[https://docs.ocsjs.com](https://docs.ocsjs.com)。Plus 版本的新增功能与原版可能有所不同。
