# OpenClaw v2026.10.6 升级记录

- [逐模块上游接口专项审计](module-api-audit.md)：功能模块/13 个扩展的实际契约对照、遗漏适配、上游敏感测试和验收边界。

本目录记录由 v2026.10.4 升级的来源、实现和验证边界，证据仅适用于本次代码及产物。

- [升级说明](upgrade.md)：原包、独立 Node、补丁及 SDK/本地源码接入决策。
- [验证记录](validation.md)：测试、完整产物、独立复审、失败修复及未验收范围。
- [启动适配与四类安装流程](module-api-audit.md#23-启动配置实际-cli-admission-与-schema-需要分别核对)：启动配置遗漏、正常数据库升级、跨版本支持范围及降级提醒/继续启动；当前契约见[启动设计](../../features/app/startup-and-history-upgrade.md)。

当前补丁能力以 [33 项总账](../../../scripts/patches/v2026.10.6/README.md)为准；历史版本的验收不能替代本次验证。
