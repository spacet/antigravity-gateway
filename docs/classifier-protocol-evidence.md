# Auto Mode 与工具协议修复证据

本分支仅交付协议补丁。默认分类提示词、parser、分阶段请求的静态版本证据在 `tests/fixtures/claude-code-2.1.284-classifier-evidence.json` 和 `tests/fixtures/claude-code-2.1.304-classifier-evidence.json`，分别包含程序哈希与必要摘录。284 官方 npm macOS arm64 制品在下载时已对照官方 registry SHA-512/SHA-1 核验；304 是本机安装制品。两个制品只做静态分析，未启动 CLI、未调用真实模型。运行时提示词和规则可被覆盖，故不宣称完整 CLI 兼容。

- 分类只接受指定判定标签起始及完整平面字段，允许完整 `<thinking>` 前缀、普通 `<`/`>` 比较符和 reason 内命令重定向。severity 仅要求 0–100 数值；默认提示词第一阶段只有分数，第二阶段的 category 是条件字段；不伪造缺失判定或依据数值代客户端判断阈值。
- block 的默认提示词是 `no` 不附 category/reason、`yes` 附两者且 reason 以匹配规则名开头；网关拒绝缺失、混合、重复、残缺、额外正文和字段冲突。category 仅验证字母数字空格与 reason 前缀一致性，无法验证实际规则是否被正确匹配。真实 CLI parser 比网关严格策略更宽松；**网关策略不等同于完整 CLI parser 契约**。
- Cloud Code 直连保留上游 finishReason/stopSequence。MAX_TOKENS→Anthropic max_tokens/Chat length/Responses incomplete；安全终止→refusal/content_filter/incomplete；未知显式结束状态返回错误，不伪装正常。正常 STOP/END_TURN 等仍可走 Auto Mode 原一次 XML 修复重试；非正常分类不能补作通过。工具截断/安全结果拒绝投影/执行，正常 STOP/TOOL_USE/TOOL_CALLS 等工具结束仍保留 ID/参数。JSON、缓冲及实时 SSE 复用结束状态；分类流式心跳头已发送后失败表现为 200 + error 事件，不能把此 200 看作成功分类。
- 所有测试是合成 mock 与本地 HTTP；实际两个版本的 Auto Mode 成功率、真实上游安全状态格式、运行时规则覆盖与低预算分类可用性**未验证**。

## 与预算实验分支的明确边界

本候选从 `8a730893e200f658af73f57961fdb3ba8ae23fb3` 建独立分支，只保留协议修复。没有引入 `src/provider-capabilities.js`、thinkingMode/reasoningBudget、effort/disabled 或其他 Provider 的新增 400；未改模型选择与账号路由。**基线原有**的 Direct Gemini 3 小预算提升到 1024、Auto Mode 提升到至少 8192 的行为保留——这可能不满足客户端严格输出预算，**不宣称该问题已修复**；不能把此分支当严格预算契约交付。预算研究、公开资料与受控验证方案留在 `/tmp/antigravity-classifier-fix-20261023`，不混入协议补丁。
