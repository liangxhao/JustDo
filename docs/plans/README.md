# 未实施需求

本目录仅保留仍明确需要记录的具体需求：

- [Office 文件与大表格](mcp-apps-office-files.md)：XLSX 结构写回、PPTX/DOCX 与容量扩展，均不代表已支持。
- [产品运行计时的终态证据收敛](session-run-terminal-evidence.md)：移除既存空闲/root 变更推断，保留未知回执；尚未实施。
- [Gateway 启动耗时](gateway-startup-latency.md)：记录本次超过一分钟的阶段耗时，后续定位与提速尚未完成。
- [浏览器共存与后台运行](browser-runtime-and-background-tasks.md)：仅保留后续 Chrome 共存、统一门面及同页宿主迁移候选；内置前后台执行已整合到浏览器功能文档，后续方案尚未实施。

现行能力和验证边界直接维护在[功能文档](../features/README.md)及对应架构说明。未排期的产品设想、重复验收矩阵和旧实施流水不再保留；需要时从 Git 历史查阅。删除计划不代表功能已经实现或验收通过。
