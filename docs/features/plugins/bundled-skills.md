# 内置 Skill 的上游与运行约束

`plugins/skills/builtin-skills.json` 选择实际打包的八个独立技能，其 `upstream`
字段记录发布版本或源码提交，仅用于维护追溯，不进入模型的 Skill 正文。
这些字段不替代 Gateway 的技能元数据、启停状态或可用性判断。

## 当前基线

下表记录清单中锁定的来源，不表示持续跟踪上游最新版本：

| 本地 ID | 上游 | 当前保留内容与适配 |
| --- | --- | --- |
| docx | [ivangdavila/word-docx](https://clawhub.ai/ivangdavila/skills/word-docx) 1.0.2 | 恢复完整的样式、编号、分节、修订、字段及兼容性指导；保留本地 ID |
| pptx | [ivangdavila/powerpoint-pptx](https://clawhub.ai/ivangdavila/skills/powerpoint-pptx) 1.0.1 | 恢复完整的模板、占位符、布局和独立内容／视觉检查指导 |
| xlsx | [ivangdavila/excel-xlsx](https://clawhub.ai/ivangdavila/skills/excel-xlsx) 1.0.2 | 恢复完整的类型、公式、模板及大文件处理指导；重算以实际可用引擎为准 |
| data-analysis | [ivangdavila/data-analysis](https://clawhub.ai/ivangdavila/skills/data-analysis) 1.0.2 | 保留分析正文和五份参考文档，移除发布卡片及市场操作 |
| frontend-design | [anthropics/skills](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design) | 同步该提交原文，补充本地资源约束 |
| diagram-design | [cathrynlavery/diagram-design](https://github.com/cathrynlavery/diagram-design/tree/7a12007b5a4246894f342a2e52e78facbc62eca3) 2.6 | 同步 45 类图形、模板、导入和导出脚本；适配本地字体、Edge 和项目配置 |
| pdf | [anthropics/skills](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/pdf) | 核对后保留既有 Python 适配；核对时七个辅助脚本与上游一致，保留 PDFium 渲染器，再补充 UTF-8 JSON 读写 |
| skill-creator | [anthropics/skills](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator) | 恢复创建、写作、测试、评分、反馈及迭代正文和评估资源；接入原生 workshop，保留已有校验／打包器 |

ClawHub 四项使用 manifest 锁定的发布版本和归档 SHA-256；变更版本时同步更新追溯信息。
PDF 的既有许可证保持原样，Office 三项继续使用原有 MIT-0 来源，
不混用 Anthropic Office 源码或更换其许可证。绘图技能包含上游 MIT 和第三方许可文件。

## 产品适配

- 保留上游有用正文、模板、参考文件和可执行脚本；移除市场安装、评价、同步命令、
  其他宿主专用命令及未打包的仓库维护检查。不将技能重写成只有概述的提示词。
  通用绘图自检不代表通过类型专属的语义／数据校验；相关规则仍需核对输入和实际渲染。
- Python 和 `openpyxl`、`pypdf`、PyYAML 等基础依赖随包提供，清单以
  `resources/python/requirements.txt` 为准。缺少的 Python 包只走已配置的内网源或离线
  wheel，不添加公网备用源，也不要求用户安装 LibreOffice、Pandoc、Poppler 或 Office。
- `python-docx`、`python-pptx`、PDFium、Pillow、ReportLab、Playwright 等是按任务需要
  使用的可选 Python 包，技能不能把它们称为预装能力。OCR 仅使用本地已有模型资产。
- HTML/SVG 使用内联资源和 Windows 本地字体；包含中文后备字体，不请求 Google Fonts
  或公共 CDN。SVG 导出去掉复制的页面样式中的字体加载规则；源 SVG 内部仍含字体加载
  规则时在写出前报错，要求先修正任务副本。绘图自检默认执行离线检查，逐个检查
  `srcset`／`imagesrcset` 图片候选地址。
- PNG 导出使用 Playwright 的已安装 Edge 通道，阻断 HTTP(S) 子请求；不下载 Chromium。
  没有相应本地能力时交付 HTML/SVG 并说明限制，不虚报渲染、重算或视觉检查。
- 绘图保留首次品牌设置、配置管理、schema 补齐、默认恢复及用户验收流程。
  工作副本是项目 `.agent-tasks/diagrams/style-guide.md`，配置库为
  `.agent-tasks/diagrams/profiles/`，项目选择保存在 `.agent-tasks/diagrams/profile`；
  普通生成只读取配置，不创建文件，也不改写安装目录或建立全局个人配置。
- 中文文件名可直接导出 SVG；非 ASCII 文件名使用稳定摘要区分元素 ID 前缀。
  三种导入格式的示例输入随脚本打包，上游第三方许可名称和归属保持原样。
- `skill-creator` 按本轮原生 `skill_workshop` 的 schema 和授权修改在线技能，不直接
  改写安装目录。普通 Workshop 修改立即生效、保存版本并可归档／恢复；个人库能力
  仅在原生实际提供时使用，按技能 ID 与 revision 读写，更新携带 expected revision，
  只发布用户请求的变更。个人库的 `proposal_content` 是版本正文，不是待审核提案。
  不增加人工 apply 门槛，不引入 Claude CLI、外部评测服务或虚构的子代理计时结果。
  测试和评估资源放在项目 `.agent-tasks/skills/<skill-name>/`。静态 reviewer 保留
  原有评分、对比和反馈流程，字体使用本地后备，XLSX 提供下载入口；不加载 SheetJS CDN。
  反馈直接下载为 JSON，不向预览服务写入。缺少实测时间或 token 数时只报告断言和定性结果。
- PDF 填表和 Skill 打包器显式解析同目录辅助模块，兼容随附 Python 3.12 的隔离导入路径；
  测试直接启动随附解释器，覆盖中文 JSON、中文及空格输出路径。

## 更新与验证

更新时先核对上游归属、版本和许可，使用固定版本／提交取得完整包，再做上述有限适配。
先逐段对照固定上游，保留可支持的原文和资源；宿主、路径或依赖冲突采用局部替换，
不将完整流程压缩成另写的摘要，也不把上游自身的重构算作本地适配。
来源信息保存在 manifest 和本文，避免占用技能运行上下文。
`taskflow/` 未被 manifest 选中，不作为内置独立技能打包。原生技能另由
manifest 的 `openclaw.skills` 与 `openclaw.custodianSkills` 筛选，当前分别保留
`coding-agent` 与 `diagnose-gateway`；这两项不计入八个独立技能，也不替代原生可用性判断。

ACPX 扩展另携带 `acp-router`。它只按产品当前配置且启用的外部 Agent 目录和实际
原生 schema 发送；上游 acpx 别名不代表产品已安装或授权。缺少依赖、连接失败或
结果未知不会触发下载安装、修改全局命令、启用 Agent、切换执行方式或重放输入。
明确直连请求也须核实与受管路径相同的命令、认证、权限和生命周期归属。

检查所有选中技能的 frontmatter、相对引用及 Python 语法，执行
`tests/scripts/sync-bundled-skills.test.ts`、skill-creator 自带测试及绘图脚本的
`test_runtime.py`。实际验证导入、离线自检、SVG 的 CSS／ID 保留、中文文件名、字体加载
规则拒绝、PNG 的离线 Edge 渲染和 PDF 表单 UTF-8 输入；缺少可选包时应明确区分跳过与通过。
