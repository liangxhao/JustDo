---
name: drawio-diagrams
description: Draw or edit flowcharts, approval processes, architecture diagrams, UML, ER and network diagrams with the bundled offline draw.io editor directly in the conversation. Use for diagram requests even when the user does not name draw.io; also use for editable .drawio diagrams. 流程图、审批图、架构图、时序图、关系图和可编辑图表。
---

# Interactive diagrams

For diagram requests, prefer the actual draw.io MCP tool so the user receives an
editable diagram in the message. This is separate from HTML widgets and data
charts. Respect an explicit request for a different format or plain source.

1. First use `drawio_diagram` with `action: "read"` when this chat has an opened
   canvas or the user asks to continue a diagram. A blank sidebar canvas is an
   existing target too. Read returns its stable ID, current XML and content stamp.
   Use `action: "update"` with that ID, `baseContentStamp`, complete XML and title
   to edit the same canvas. Preserve unrelated pages and existing cell IDs.
   The successful result is already applied and undoable; do not create another
   editor. Resolve ambiguity with the user, and preserve manual edits on conflict.
   Never replay a result reported unknown. For an explicitly new diagram, or
   when no canvas is prepared, discover the available drawing tool with native search:
   `drawio create_diagram` (or `draw.io diagram`). MCP tools may be searchable
   without appearing in the compact tool directory. Read the returned schema
   and invoke its exact tool ID through the advertised tool calling interface.
   Do not guess an ID or call a session/chat handoff tool to execute it.
2. Pass uncompressed `mxfile` or `mxGraphModel` XML to `create_diagram`, with a
   short title in the user's language. Include root cells `0` and `1`, positioned
   vertices with geometry, and edges with source and target IDs. Use decision
   diamonds, labelled branches, aligned shapes, readable spacing, restrained
   colors and orthogonal connectors. Escape XML attribute values correctly.
3. The successful MCP result embeds the interactive editor in the conversation.
   Do not substitute a written `.drawio` file, HTML file, XML code block, image or
   a claim that an editor opened. Do not use shell/file tools merely to bypass
   discovery. If the tool is unavailable or fails, explain that accurately;
   offer another format without claiming an interactive result.

Use local shapes and fonts; do not fetch public assets or open a public editor.
Supply reasonable assumptions for an illustrative diagram; ask only for details
that materially change the requested result. After a successful tool call, end
the turn without a recap, node list, status report or usage tutorial. If prose is
essential, add only new information in at most one short sentence.
Users can edit the embedded diagram and save its source or export PNG/SVG using
the editor's existing controls.
