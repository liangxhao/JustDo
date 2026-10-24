# Offline libraries for show_widget

Use this reference only when the current native `show_widget` schema offers
`kind: "offline-html"`. The installation supplies the libraries below. Ordinary
`kind: "html"` does not preload them. A missing kind requires another supported
presentation, not a guessed resource URL or a package installation.

## Source contract

`widget_code` is a JSON **string** containing exactly:

```json
{
  "version": 1,
  "libraries": ["echarts"],
  "html": "<div id=\"sales-chart\" style=\"width:100%;height:320px\"></div><script>const chart=echarts.init(document.getElementById('sales-chart'),null,{renderer:'svg'});chart.setOption({tooltip:{},xAxis:{type:'category',data:['A','B','C']},yAxis:{type:'value'},series:[{type:'bar',data:[12,18,9]}]});const resize=new ResizeObserver(()=>chart.resize());resize.observe(document.getElementById('sales-chart'));window.addEventListener('pagehide',()=>{resize.disconnect();chart.dispose();},{once:true});</script>"
}
```

The actual tool arguments wrap that object as a string:

```json
{
  "title": "Sales comparison",
  "kind": "offline-html",
  "widget_code": "{\"version\":1,\"libraries\":[\"echarts\"],\"html\":\"<div id=\\\"sales-chart\\\" style=\\\"width:100%;height:320px\\\"></div><script>const chart=echarts.init(document.getElementById('sales-chart'),null,{renderer:'svg'});chart.setOption({xAxis:{type:'category',data:['A','B']},yAxis:{type:'value'},series:[{type:'bar',data:[12,18]}]});new ResizeObserver(()=>chart.resize()).observe(document.getElementById('sales-chart'));</script>\"}"
}
```

Use a nonempty, duplicate-free list of the exact IDs below, at most six. The
complete source string is limited to 262144 characters. `html` is a nonempty
HTML/SVG fragment with optional inline styles and classic scripts, not a full
document, file path or Markdown fence. Unknown fields and library IDs are
rejected. For content needing no library, use ordinary `html` instead.

The host loads the declared scripts in order before the fragment. Globals are
available to its inline scripts; no `import`, import map, `require`, JSX compiler,
CDN, manual script URL or library code dump is needed. Multiple libraries can
share one document, for example `["three", "katex"]` for a 3D explanation with
equations. Only select the libraries actually used.

## Available libraries

| ID        | Globals                                           | Use                                                               |
| --------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `three`   | `THREE`, `THREE.OrbitControls`                    | WebGL 3D scenes and orbit interaction.                            |
| `echarts` | `echarts`                                         | Interactive charts, including scatter, heatmap, sankey and trees. |
| `katex`   | `katex`, `renderMathInElement`, `katexFontsReady` | Math notation, auto-rendering, bundled CSS and fonts.             |
| `mermaid` | `mermaid`                                         | Flowcharts, sequence diagrams, state diagrams and Gantt charts.   |
| `d3`      | `d3`                                              | Custom SVG/data layouts, scales, force simulation, drag and zoom. |
| `matter`  | `Matter`                                          | 2D rigid-body collision, gravity and constraints.                 |

These globals exist only in the current document. Library versions are pinned
by the installation; do not assume the newest upstream API or load third-party
plugins. The libraries do not grant access to the parent, Gateway, disk, remote
APIs or persistence. Source validation checks the envelope; JavaScript errors
are reported by the existing runtime error surface. Review scripts before use.

## Three.js

Create the scene with `new THREE.Scene()`, `new THREE.PerspectiveCamera(...)`
and `new THREE.WebGLRenderer(...)`. OrbitControls is available as
`new THREE.OrbitControls(camera, renderer.domElement)` without another import.
Size the renderer and camera to the actual container using ResizeObserver;
cap pixel ratio for large scenes. Give the container an explicit useful height
in chat and adapt it to the enlarged viewport.

Catch WebGL initialization failures and display readable fallback content.
Use primitives, `CanvasTexture`, `DataTexture` or embedded `data:` images.
Remote textures, `GLTFLoader.load()` network requests, DRACO/KTX decoders,
WebGPU, external workers and arbitrary addons are not supplied by this bundle.
Stop expensive work while hidden and dispose controls, observers and the
renderer on page exit. System reduced-motion preferences must not disable a
requested animation or simulation.

## ECharts

Use `echarts.init(element, null, { renderer: 'svg' })` or the Canvas renderer,
then `setOption` with data already embedded in the source. Give the element a
real height before initialization. ResizeObserver should call `chart.resize()`
when chat, enlarged view or sidebar dimensions change; disconnect it and
dispose the chart on page exit. Do not fetch datasets, maps or themes from a
remote URL. Geographic datasets are separate assets and are not bundled.

## KaTeX

The selected library includes CSS and all required WOFF2 fonts. Fonts are
registered from bundled byte buffers, avoiding URL requests in the sandbox.
For exact layout or to expose a font failure, await `katexFontsReady` before
rendering; handle its rejection visibly. For example, inside an async function:

```js
await katexFontsReady;
katex.render('\\int_0^1 x^2\\,dx=\\frac{1}{3}', equationElement, {
  displayMode: true,
  throwOnError: false,
  trust: false,
});
```

For delimiters in a text container use `renderMathInElement(container, options)`
after its content exists. Keep `trust: false`; URLs, image macros and external
font stylesheets are not an offline asset mechanism.

## Mermaid

Initialize with `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })`.
Then use `const { svg } = await mermaid.render(uniqueId, source)` and place the
SVG in the intended container. Use distinct IDs for multiple diagrams, handle
parse/render errors and theme the diagram for the current host. Use the bundled
diagram types; external diagram loaders and optional external layout engines
are not an installation capability.

## D3

Use local data with `d3.select`, `d3.scaleLinear`, `d3.hierarchy`,
`d3.forceSimulation`, `d3.drag` or `d3.zoom` as needed. Prefer embedded objects
or arrays. For CSV/TSV use `d3.csvParseRows` or `d3.tsvParseRows` and map columns
explicitly; `csvParse` and `tsvParse` generate functions that the sandbox CSP
blocks. `d3.csv(url)` and `d3.json(url)` perform blocked network requests.
Use a responsive SVG viewBox and resize-dependent layout; stop force simulations
and timers on exit. Avoid external images and remote example datasets.

## Matter.js

Create an engine with `Matter.Engine.create()`, add bodies with
`Matter.Composite.add(engine.world, bodies)` and advance it with
`Matter.Engine.update(engine, delta)`. Render with Canvas, SVG or Matter.Render.
Keep coordinates in sync with container dimensions, pause while hidden and
stop any runner/render loop on page exit. Use geometry and local drawing;
remote sprite textures are blocked by the same image policy as other widgets.

## Delivery and failures

All scripts and fonts come from the installation; a clean first use works with
public networking blocked and no browser cache. A missing or damaged resource
must show the existing load/runtime error. Do not silently fall back to a CDN,
claim a blank result succeeded or retry an uncertain tool call. Data, model
files, textures and map tiles must be embedded or separately provided through
an explicitly supported capability. Native draft confirmation, source identity,
history and local-state lifetime remain the same as ordinary widgets.
