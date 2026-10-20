# 工作区文件预览

文件树、消息中的本地 `MEDIA` 附件和摘要复用侧栏文件页签。PDF 等由 Chromium 承载的非 HTML 文件预览隐藏应用浏览器的后退、前进、刷新、地址栏和更多菜单，保留文件信息行、文件树及 PDF 自带的翻页、缩放、下载和打印工具；HTML 预览和普通网页浏览仍显示导航栏。重复打开复用原页签，打开时保留文件树当前可见性。HTML 消息链接仍沿浏览器打开偏好处理；HTTP(S) 附件继续进入浏览器，不另存副本。

首页与会话中的本地文件页签（包括文件 App 和暂不支持预览的文件）按真实文件名复用文件树的 `WorkspaceFileIcon`，保持图案和颜色一致；标签页列表沿用同一图标。只有一个当前文件 App 入口匹配时，优先使用入口 `icons`，其次服务 `icons`；支持深浅主题，显示为 16 px 文件图标。缺少图标、解码失败、图标来源不符合内嵌图片限制或存在多个匹配入口时，保留内置文件类型图标。

图标来自当前首页或会话的原生发现目录，通过工作区 React Context 共享；独立窗口和标签页列表沿用该作用域，不建立全局或持久化图标注册表。MCP 配置完成、扩展状态变化或认证绑定变化后清除旧目录并重新发现，迟到响应不能恢复旧图标。安装／启用且成功发现后显示插件图标，关闭、卸载或目录不可用时回退；不因展示图标启动插件工具、读取本机图标或请求公网资源。

无导航栏的文件预览不处理内部浏览器标签页的创建、关闭、恢复或切换命令，也不激活地址栏，避免快捷键将原文件变成无法恢复的空白页。文件通过工作区文件页签关闭；刷新及已有页面的前进、后退仍可用。HTML 和普通浏览器保留原有快捷键。

## 格式清单

| 类型       | 格式                                                                                                                                                                                            | 显示方式                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| PDF        | `pdf`                                                                                                                                                                                           | Chromium 原生 PDF 查看器                             |
| 网页       | `html htm xhtml`                                                                                                                                                                                | 原生 `file://` 页面，可切换源码编辑                  |
| Markdown   | `md markdown`                                                                                                                                                                                   | 渲染阅读，可切换源码编辑                             |
| 图片       | `png apng jpg jpeg jpe jfif pjpeg pjp gif webp svg bmp ico avif`                                                                                                                                | 原有图片预览，支持缩放和拖动                         |
| 音频       | `mp3 wav wave ogg oga opus flac m4a m4b aac weba`                                                                                                                                               | Chromium 原生音频控件                                |
| 视频       | `mp4 m4v webm mov mkv`                                                                                                                                                                          | Chromium 原生视频控件，是否可播放取决于容器内编码    |
| 数据、配置 | `json jsonc jsonl ndjson csv tsv yaml yml toml ini xml conf properties cfg config cnf lock service desktop`                                                                                     | 文本／源码编辑；CSV、TSV 不作为电子表格渲染          |
| 字幕、补丁 | `srt vtt ass lrc diff patch`                                                                                                                                                                    | 文本／源码编辑                                       |
| 源码       | `js cjs mjs jsx ts cts mts tsx css scss less py sh bash ps1 bat java go rs c h cpp cs sql vue svelte astro rb php lua r kt kts swift scala hpp cc cxx sass styl graphql gql proto http rest mk` | 源码编辑，不执行文件或编译项目                       |
| 其他文本   | `txt log rst adoc tex bib ipynb`                                                                                                                                                                | 文本／源码编辑；Notebook 展示原始 JSON，不运行单元格 |

`.env`、`.env.*`、Dockerfile、Makefile、LICENSE、NOTICE、README 类 Markdown 及已有点文件配置沿现有文本准入。源码和文本仍有 2 MiB 上限、编辑授权、版本冲突与未保存修改确认；PDF 和音视频仅准备真实文件地址，不解码成文本、不授予编辑权限、不应用该文本上限。

## 播放与资源生命周期

音视频使用已有 `localmedia://local/` 流式协议，不启动 HTTP 服务、不把整个媒体文件经 IPC 复制到 Renderer。字节 Range 支持拖动进度，路径转义只解码一次，并保留 Windows、中文、空格、`#`、`%` 和 UNC 文件路径。

默认仅准备媒体元数据，不自动播放。切走文件页签或收起整个工作区时暂停；重新显示后由用户继续播放。工作区拆到独立窗口且仍可见时保留播放。关闭文件或换源后停止并释放播放资源。解码失败显示明确提示，支持用户重新加载和使用系统应用打开。扩展名只能确定打开入口，不能保证所有编码都可播放；MOV、MKV 等容器尤其依赖文件内实际编码。不在首次使用时下载解码器或转换工具。

## 需要专门处理器的格式

| 类型                             | 常见格式                                   | 当前入口                                                       |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Office / OpenDocument            | `doc docx xls xlsx ppt pptx odt ods odp`   | 复用已安装文件 App 的原生发现；没有匹配 App 时显示文件操作卡片 |
| 图表和设计文件                   | `drawio psd ai sketch fig`                 | 有匹配文件 App 时交给插件；内置 draw.io 保留自身处理器         |
| 浏览器无内置解码器的图片／媒体   | `tif tiff heic raw wma ape avi wmv ogv` 等 | 保留系统应用打开入口；当前 Electron 实测 OGV/Theora 无法解码   |
| 压缩包、数据库、工程与可执行文件 | `zip rar 7z sqlite db dwg dxf exe dll` 等  | 没有通用内置渲染器，显示文件操作卡片或交给实际匹配的文件 App   |

所有本地消息附件都进入与文件树相同的路由，以便已安装文件 App 处理上述格式；不会在缺少渲染器时自动启动系统应用。文件 App 准入、会话身份与未知结果处理见 [MCP Apps](../chat/mcp-apps.md)。

内置 draw.io 通过同一文件 App 发现流程声明 `.drawio` 入口，打开当前会话工作区内
的已有图表（UTF-8 XML，最多 1 MiB），在编辑器中渲染原文件内容。打开与编辑不
自动覆盖原文件，保存沿用现有文件对话框；详见 [draw.io 离线绘图](../chat/drawio-offline.md)。
