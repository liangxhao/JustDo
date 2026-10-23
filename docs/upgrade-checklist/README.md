# OpenClaw 升级检查清单

本目录统一维护升级检查事项，先读[总清单](checklist.md)，再核对受影响的专题。
补丁总账和实际验证记录继续由各版本目录维护。

| 专题 | 使用时机 |
| --- | --- |
| [流式、执行与恢复](streaming-and-execution.md) | 对照消息协议、Provider/SDK、Goal 与问答行为 |
| [宿主、插件与发行](host-and-release.md) | 对照 Apps、CLI/ACP、凭据、技能、存储与安装包 |

每项均需按目标版本记录「通过 / 需适配 / 未验证 / 不适用」及证据。
当前编号仅指 2026.10.4；升级后依能力语义追踪，不能照搬编号。
补丁依赖、删除条件以目标版本 `scripts/patches/<version>/README.md` 为准；
实际产物与执行结果写入 `docs/openclaw-upgrades/<version>/`。
