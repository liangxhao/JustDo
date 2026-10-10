import type { UiLabels } from './labels';
import type { UiBlock, UiDocument, UiFormField } from './schema';

export type UiBoot = { document: UiDocument; labels: UiLabels };

/** Serialized as a fixed resource: every executable helper stays in this function. */
export function uiRuntime(boot: UiBoot): void {
  const doc = boot.document;
  const l = boot.labels;
  const root = document.getElementById('interactive-answer-root');
  if (!root) return;
  const locale = doc.language === 'zh' ? 'zh-CN' : 'en-US';
  const format = new Intl.NumberFormat(locale, { maximumSignificantDigits: 15 });
  const compact = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumSignificantDigits: 3,
  });
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  const host = globalThis as typeof globalThis & {
    openclaw?: { prompt?: { send?: (value: string) => unknown } };
  };
  type Value = { id: string; label: string; value: string | number | boolean | null };
  type Controller = {
    block: UiBlock;
    panel: HTMLElement;
    button: HTMLButtonElement;
    values: () => Value[];
    onShow?: () => void;
  };
  type FieldState = {
    field: UiFormField;
    input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    error: HTMLElement;
    controller: Controller;
    value: Value['value'];
    problem: string;
  };
  const controllers: Controller[] = [];
  const fields: FieldState[] = [];
  let activePanel = 0;
  let draftAvailable = false;
  let pending = false;
  const make = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text = '', className = '') => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text: string, className = '') => {
    const node = make('button', text, className);
    node.type = 'button';
    return node;
  };
  const clip = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    let result = text.slice(0, Math.max(0, limit - 1));
    if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
    return result + '…';
  };
  const display = (value: string | number) =>
    typeof value === 'number' ? format.format(value) : value;
  const nav = make('nav', '', 'ui-nav');
  nav.setAttribute('aria-label', doc.summary);
  const footer = make('footer', '', 'ui-footer');
  const follow = button(l.unavailable, 'ui-follow');
  follow.id = 'ui-follow';
  follow.disabled = true;
  const fullDetails = make('details');
  fullDetails.appendChild(make('summary', l.fullValues));
  const fullValues = make('textarea', '', 'ui-full-values');
  fullValues.id = 'ui-full-values';
  fullValues.readOnly = true;
  fullValues.spellcheck = false;
  fullValues.setAttribute('aria-label', l.fullValues);
  fullDetails.append(make('p', l.copyHint, 'ui-help'), fullValues);
  const shortened = make('p', l.truncated, 'ui-help');
  shortened.hidden = true;
  const formStatus = make('p', '', 'ui-error');
  formStatus.setAttribute('role', 'status');
  formStatus.setAttribute('aria-live', 'polite');
  footer.append(follow, formStatus, shortened, fullDetails, make('p', l.resetNotice, 'ui-help'));
  root.replaceChildren(make('h2', doc.summary));
  root.lang = doc.language;
  if (doc.note) root.appendChild(make('p', doc.note, 'ui-note'));
  if (doc.blocks.length > 1) root.appendChild(nav);

  function showPanel(index: number): void {
    activePanel = index;
    controllers.forEach((controller, candidate) => {
      controller.panel.hidden = candidate !== index;
      controller.button.setAttribute('aria-pressed', String(candidate === index));
      if (candidate === index) controller.onShow?.();
    });
  }

  function snapshots() {
    return controllers.map(controller => ({
      id: controller.block.id,
      type: controller.block.type,
      title: controller.block.title,
      values: controller.values(),
    }));
  }

  function draftFor(selection: ReturnType<typeof snapshots>): { text: string; shortened: boolean } {
    const prefix = `${l.followInstruction}\n${l.valuesHeading}\n`;
    const encodedClip = (value: string, limit: number): string => {
      if (JSON.stringify(value).length <= limit) return value;
      let low = 1;
      let high = value.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (JSON.stringify(clip(value, middle)).length <= limit) low = middle;
        else high = middle - 1;
      }
      return clip(value, low);
    };
    const title = encodedClip(clip(doc.summary, 200), 300);
    const titleTruncated = title !== doc.summary;
    const blocks = selection.map(block => ({
      id: block.id,
      type: block.type,
      title: encodedClip(block.title, 128),
      titleTruncated: JSON.stringify(block.title).length > 128,
      values: [] as Value[],
      omitted: 0,
      truncated: 0,
    }));
    const baseLength = prefix.length + JSON.stringify({ title, titleTruncated, blocks }).length;
    // Reserve room for counter digit growth. Every block gets its own share.
    const extra = Math.max(0, Math.floor((3600 - baseLength - 80) / blocks.length));
    blocks.forEach((block, index) => {
      const limit = JSON.stringify(block).length + extra;
      for (const value of selection[index].values) {
        const entry: Value = {
          id: value.id,
          label: clip(value.label, 40),
          value: typeof value.value === 'string' ? clip(value.value, 120) : value.value,
        };
        block.values.push(entry);
        // Shorten an individual string further before omitting it entirely.
        while (
          JSON.stringify(block).length > limit &&
          typeof entry.value === 'string' &&
          entry.value.length > 1
        ) {
          entry.value = clip(
            entry.value,
            Math.max(1, entry.value.length - (JSON.stringify(block).length - limit)),
          );
        }
        while (JSON.stringify(block).length > limit && entry.label.length > 1) {
          entry.label = clip(
            entry.label,
            Math.max(1, entry.label.length - (JSON.stringify(block).length - limit)),
          );
        }
        if (JSON.stringify(block).length > limit) {
          block.values.pop();
          block.omitted++;
        }
      }
      while (JSON.stringify(block).length > limit && block.values.length) {
        block.values.pop();
        block.omitted++;
      }
      block.truncated = block.values.filter(entry => {
        const original = selection[index].values.find(value => value.id === entry.id)!;
        return original.label !== entry.label || original.value !== entry.value;
      }).length;
    });
    const text = prefix + JSON.stringify({ title, titleTruncated, blocks });
    return {
      text,
      shortened:
        titleTruncated ||
        blocks.some(block => block.titleTruncated || block.omitted || block.truncated),
    };
  }

  function refresh(): void {
    const selection = snapshots();
    fullValues.value = JSON.stringify({ title: doc.summary, blocks: selection }, null, 2);
    shortened.hidden = !draftFor(selection).shortened;
  }

  function pager(
    parent: HTMLElement,
    count: () => number,
    page: () => number,
    change: (value: number) => void,
  ) {
    const container = make('div', '', 'ui-pager');
    const previous = button(l.previous);
    const next = button(l.next);
    const status = make('span', '', 'ui-count');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    previous.addEventListener('click', () => change(Math.max(0, page() - 1)));
    next.addEventListener('click', () =>
      change(Math.min(Math.max(0, Math.ceil(count() / 5) - 1), page() + 1)),
    );
    container.append(previous, status, next);
    parent.appendChild(container);
    return () => {
      const total = count();
      previous.disabled = page() <= 0;
      next.disabled = page() >= Math.max(0, Math.ceil(total / 5) - 1);
      status.textContent = `${total} ${l.rows} · ${page() + 1} / ${Math.max(1, Math.ceil(total / 5))} ${l.page}`;
    };
  }

  function exclusiveDetails(
    details: HTMLDetailsElement[],
    group: string,
    changed?: () => void,
  ): void {
    details.forEach(detail => {
      // Native grouping closes the previous item before layout; the toggle
      // listener also preserves this behavior in non-visual DOM environments.
      detail.setAttribute('name', group);
      detail.addEventListener('toggle', () => {
        if (detail.open)
          details.forEach(other => {
            if (other !== detail) other.open = false;
          });
        changed?.();
      });
    });
  }

  function fillValues(
    list: HTMLElement,
    entries: { label: string; value: string | number }[],
    group: string,
  ): void {
    const expanded: HTMLDetailsElement[] = [];
    list.replaceChildren();
    entries.forEach(({ label, value }) => {
      const text = display(value);
      const content = make('dd');
      if (text.length <= 80) content.textContent = text;
      else {
        const detail = make('details', '', 'ui-value-detail');
        const summary = make('summary', l.fullValue);
        summary.setAttribute('aria-label', `${label}: ${l.fullValue}`);
        detail.append(summary, make('p', text));
        expanded.push(detail);
        content.appendChild(detail);
      }
      list.append(make('dt', label), content);
    });
    exclusiveDetails(expanded, group);
  }

  function setupTable(block: Extract<UiBlock, { type: 'table' }>, controller: Controller): void {
    const panel = controller.panel;
    const searchLabel = make('label', l.search, 'ui-search');
    const search = make('input');
    search.type = 'search';
    search.maxLength = 400;
    search.id = `ui_${block.id}_search`;
    searchLabel.htmlFor = search.id;
    searchLabel.appendChild(search);
    panel.appendChild(searchLabel);
    const wrapper = make('div', '', 'ui-table-wrap');
    const table = make('table');
    table.appendChild(make('caption', block.title));
    const head = make('thead');
    const headRow = make('tr');
    const body = make('tbody');
    let page = 0;
    let sort = -1;
    let descending = false;
    let selectedRow: number | null = null;
    let filtered = block.rows.map((row, index) => ({ row, index }));
    const headers = block.columns.map((column, index) => {
      const cell = make('th');
      cell.scope = 'col';
      cell.setAttribute('aria-sort', 'none');
      const sortButton = button(column.label);
      sortButton.setAttribute('aria-label', `${column.label}: ${l.sort}`);
      sortButton.addEventListener('click', () => {
        descending = sort === index ? !descending : false;
        sort = index;
        page = 0;
        selectedRow = null;
        update();
      });
      cell.appendChild(sortButton);
      headRow.appendChild(cell);
      return cell;
    });
    const detailHead = make('th', l.rowDetails);
    detailHead.scope = 'col';
    headRow.appendChild(detailHead);
    head.appendChild(headRow);
    table.append(head, body);
    wrapper.appendChild(table);
    panel.appendChild(wrapper);
    const updatePager = pager(
      panel,
      () => filtered.length,
      () => page,
      value => {
        page = value;
        selectedRow = null;
        update();
      },
    );
    const details = make('section', '', 'ui-details');
    details.id = `ui_${block.id}_row_details`;
    details.hidden = true;
    const detailTitle = make('h3', l.rowDetails);
    const detailValues = make('dl');
    const close = button(l.closeDetails);
    close.addEventListener('click', () => {
      const previousRow = selectedRow;
      selectedRow = null;
      updateDetails();
      body.querySelector<HTMLButtonElement>(`button[data-row="${previousRow}"]`)?.focus();
      refresh();
    });
    details.append(detailTitle, detailValues, close);
    panel.appendChild(details);
    function updateDetails(): void {
      details.hidden = selectedRow === null;
      detailValues.replaceChildren();
      if (selectedRow !== null)
        fillValues(
          detailValues,
          block.columns.map((column, columnIndex) => ({
            label: column.label,
            value: block.rows[selectedRow!][columnIndex],
          })),
          `ui_${block.id}_values`,
        );
      body.querySelectorAll<HTMLButtonElement>('button[data-row]').forEach(rowButton => {
        rowButton.setAttribute(
          'aria-expanded',
          String(Number(rowButton.dataset.row) === selectedRow),
        );
      });
    }
    function update(): void {
      const query = search.value.trim().toLocaleLowerCase(locale);
      filtered = block.rows
        .map((row, index) => ({ row, index }))
        .filter(entry =>
          entry.row.some(value => String(value).toLocaleLowerCase(locale).includes(query)),
        );
      if (sort >= 0)
        filtered.sort((left, right) => {
          const a = left.row[sort];
          const b = right.row[sort];
          const order =
            typeof a === 'number' && typeof b === 'number'
              ? a - b
              : collator.compare(String(a), String(b));
          return (descending ? -order : order) || left.index - right.index;
        });
      page = Math.min(page, Math.max(0, Math.ceil(filtered.length / 5) - 1));
      headers.forEach((header, index) =>
        header.setAttribute(
          'aria-sort',
          sort === index ? (descending ? 'descending' : 'ascending') : 'none',
        ),
      );
      body.replaceChildren();
      if (!filtered.length) {
        const row = make('tr');
        const cell = make('td', l.noResults);
        cell.colSpan = block.columns.length + 1;
        row.appendChild(cell);
        body.appendChild(row);
      }
      filtered.slice(page * 5, page * 5 + 5).forEach(entry => {
        const row = make('tr');
        entry.row.forEach(value => row.appendChild(make('td', clip(display(value), 80))));
        const cell = make('td');
        const rowButton = button(`${l.rowDetails} ${entry.index + 1}`);
        rowButton.dataset.row = String(entry.index);
        rowButton.setAttribute('aria-controls', details.id);
        rowButton.addEventListener('click', () => {
          selectedRow = selectedRow === entry.index ? null : entry.index;
          updateDetails();
          refresh();
        });
        cell.appendChild(rowButton);
        row.appendChild(cell);
        body.appendChild(row);
      });
      updateDetails();
      updatePager();
      refresh();
    }
    search.addEventListener('input', () => {
      page = 0;
      selectedRow = null;
      update();
    });
    controller.values = () => [
      { id: 'query', label: l.query, value: search.value },
      {
        id: 'sort',
        label: l.sort,
        value:
          sort < 0
            ? ''
            : `${block.columns[sort].label}: ${descending ? l.descending : l.ascending}`,
      },
      { id: 'page', label: l.page, value: page + 1 },
      { id: 'row', label: l.selected, value: selectedRow === null ? null : selectedRow + 1 },
    ];
    update();
  }

  function setupCompare(
    block: Extract<UiBlock, { type: 'compare' }>,
    controller: Controller,
  ): void {
    const panel = controller.panel;
    let selected: number | null = null;
    const options = make('div', '', 'ui-options');
    const details = make('section', '', 'ui-compare');
    const status = make('h3', l.selectPlan);
    const values = make('dl');
    details.append(status, values);
    const buttons = block.items.map((item, index) => {
      const option = button(item.title);
      option.setAttribute('aria-pressed', 'false');
      option.addEventListener('click', () => {
        selected = index;
        buttons.forEach((candidate, candidateIndex) =>
          candidate.setAttribute('aria-pressed', String(candidateIndex === index)),
        );
        status.textContent = `${l.selected}: ${item.title}`;
        fillValues(
          values,
          block.metrics.map((metric, metricIndex) => ({
            label: metric,
            value: item.values[metricIndex],
          })),
          `ui_${block.id}_values`,
        );
        refresh();
      });
      options.appendChild(option);
      return option;
    });
    const wrapper = make('div', '', 'ui-table-wrap');
    const table = make('table');
    table.appendChild(make('caption', block.title));
    const head = make('thead');
    const header = make('tr');
    const category = make('th', l.category);
    category.scope = 'col';
    header.appendChild(category);
    block.items.forEach(item => {
      const cell = make('th', item.title);
      cell.scope = 'col';
      header.appendChild(cell);
    });
    head.appendChild(header);
    const body = make('tbody');
    block.metrics.forEach((metric, index) => {
      const row = make('tr');
      const label = make('th', metric);
      label.scope = 'row';
      row.appendChild(label);
      block.items.forEach(item =>
        row.appendChild(make('td', clip(display(item.values[index]), 80))),
      );
      body.appendChild(row);
    });
    table.append(head, body);
    wrapper.appendChild(table);
    panel.append(options, wrapper, details);
    controller.values = () =>
      selected === null
        ? [{ id: 'selected', label: l.selected, value: null }]
        : [
            { id: 'selected', label: l.selected, value: block.items[selected].id },
            ...block.metrics.map((metric, index) => ({
              id: `metric-${index}`,
              label: metric,
              value: block.items[selected!].values[index],
            })),
          ];
  }

  function setupChart(block: Extract<UiBlock, { type: 'chart' }>, controller: Controller): void {
    const panel = controller.panel;
    const visible = new Set(block.series.map(series => series.id));
    const colors = [
      'var(--accent,#287d68)',
      'var(--danger,#b42318)',
      'var(--warn,#a66519)',
      'var(--text,#252b32)',
    ];
    const dashes = ['', '8 4', '2 4', '8 3 2 3'];
    const legend = make('div', '', 'ui-legend');
    const canvas = make('div');
    const empty = make('p', l.noSeries, 'ui-chart-empty');
    empty.setAttribute('role', 'status');
    const seriesButtons = block.series.map((series, index) => {
      const toggle = button(series.label);
      toggle.setAttribute('aria-pressed', 'true');
      toggle.setAttribute('aria-label', `${l.series}: ${series.label}`);
      const swatch = make('span', '', 'ui-swatch');
      swatch.style.background = colors[index];
      swatch.setAttribute('aria-hidden', 'true');
      toggle.prepend(swatch);
      toggle.addEventListener('click', () => {
        if (visible.has(series.id)) visible.delete(series.id);
        else visible.add(series.id);
        toggle.setAttribute('aria-pressed', String(visible.has(series.id)));
        draw();
        refresh();
      });
      legend.appendChild(toggle);
      return toggle;
    });
    panel.append(legend, canvas, empty);
    if (block.unit) panel.appendChild(make('p', block.unit, 'ui-help'));
    const svgNode = (tag: string, attributes: Record<string, string | number> = {}, text = '') => {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
      if (text) node.textContent = text;
      return node;
    };
    let drawnWidth = 0;
    const canvasWidth = () => {
      const measured = canvas.clientWidth || canvas.getBoundingClientRect().width;
      return measured > 0 ? Math.max(140, Math.round(measured)) : drawnWidth || 680;
    };
    function draw(): void {
      const width = canvasWidth();
      drawnWidth = width;
      const left = 68;
      const plotWidth = width - left - 14;
      canvas.replaceChildren();
      empty.hidden = visible.size > 0;
      if (!visible.size) return;
      const shown = block.series
        .map((series, index) => ({ series, index }))
        .filter(({ series }) => visible.has(series.id));
      const points = shown.flatMap(({ series }) => series.values);
      const minimum = Math.min(0, ...points);
      const maximum = Math.max(0, ...points) || (minimum === 0 ? 1 : 0);
      const span = maximum - minimum || 1;
      const x = (index: number) =>
        block.chartType === 'bar'
          ? left + (index + 0.5) * (plotWidth / block.labels.length)
          : left + index * (plotWidth / Math.max(1, block.labels.length - 1));
      const y = (value: number) => 205 - ((value - minimum) / span) * 175;
      const svg = svgNode('svg', {
        viewBox: `0 0 ${width} 260`,
        class: 'ui-chart',
        role: 'img',
        'aria-labelledby': `ui_${block.id}_chart_description`,
      });
      svg.appendChild(
        svgNode(
          'title',
          { id: `ui_${block.id}_chart_description` },
          `${block.title}: ${shown.map(({ series }) => series.label).join(', ')}`,
        ),
      );
      for (let tick = 0; tick <= 4; tick++) {
        const value = minimum + (span * tick) / 4;
        const position = y(value);
        svg.appendChild(
          svgNode('line', {
            x1: left,
            x2: left + plotWidth,
            y1: position,
            y2: position,
            class: 'ui-axis',
          }),
        );
        if (Math.abs(position - y(0)) > 13)
          svg.appendChild(
            svgNode(
              'text',
              { x: left - 8, y: position + 4, 'text-anchor': 'end' },
              compact.format(value),
            ),
          );
      }
      svg.append(
        svgNode('line', {
          x1: left,
          x2: left + plotWidth,
          y1: y(0),
          y2: y(0),
          class: 'ui-axis ui-zero',
        }),
        svgNode('text', { x: left - 8, y: y(0) + 4, 'text-anchor': 'end' }, format.format(0)),
      );
      const labelCount = Math.min(block.labels.length, Math.max(2, Math.floor(plotWidth / 90) + 1));
      const glyphWidth = block.labels.some(label => /[^\u0000-\u02ff]/.test(label)) ? 12 : 7;
      const labelLimit = Math.max(
        1,
        Math.min(
          18,
          Math.floor(
            ((plotWidth / (labelCount - 1)) * (labelCount === 2 ? 0.45 : 0.6)) / glyphWidth,
          ),
        ),
      );
      for (let slot = 0; slot < labelCount; slot++) {
        const index = Math.round((slot * (block.labels.length - 1)) / (labelCount - 1));
        const label = block.labels[index];
        const text = svgNode(
          'text',
          {
            x: x(index),
            y: 232,
            'text-anchor':
              index === 0 ? 'start' : index === block.labels.length - 1 ? 'end' : 'middle',
          },
          clip(label, labelLimit),
        );
        text.appendChild(svgNode('title', {}, label));
        svg.appendChild(text);
      }
      const defs = svgNode('defs');
      svg.appendChild(defs);
      shown.forEach(({ series, index }, visibleIndex) => {
        if (block.chartType === 'line') {
          svg.appendChild(
            svgNode('polyline', {
              points: series.values.map((value, point) => `${x(point)},${y(value)}`).join(' '),
              fill: 'none',
              stroke: colors[index],
              'stroke-width': 2.5,
              'stroke-dasharray': dashes[index],
            }),
          );
          series.values.forEach((value, point) => {
            const mark =
              index % 2 === 0
                ? svgNode('circle', {
                    cx: x(point),
                    cy: y(value),
                    r: index === 0 ? 3 : 4,
                    fill: colors[index],
                  })
                : svgNode('rect', {
                    x: x(point) - 3,
                    y: y(value) - 3,
                    width: 6,
                    height: 6,
                    fill: colors[index],
                  });
            mark.appendChild(
              svgNode(
                'title',
                {},
                `${series.label} · ${block.labels[point]}: ${format.format(value)}`,
              ),
            );
            svg.appendChild(mark);
          });
        } else {
          const patternId = `ui_${block.id}_pattern_${index}`;
          const pattern = svgNode('pattern', {
            id: patternId,
            width: 5 + index * 3,
            height: 5 + index * 3,
            patternUnits: 'userSpaceOnUse',
          });
          pattern.append(
            svgNode('rect', { width: 20, height: 20, fill: colors[index], opacity: 0.25 }),
            svgNode('path', {
              d: index % 2 ? 'M0 0L20 20' : 'M0 20L20 0',
              stroke: colors[index],
              'stroke-width': 2,
            }),
          );
          defs.appendChild(pattern);
          const groupWidth = plotWidth / block.labels.length;
          const barWidth = (groupWidth * 0.8) / shown.length;
          series.values.forEach((value, point) => {
            const bar = svgNode('rect', {
              x: left + groupWidth * point + groupWidth * 0.1 + visibleIndex * barWidth,
              y: Math.min(y(0), y(value)),
              width: Math.max(0.5, barWidth - 1),
              height: Math.abs(y(value) - y(0)),
              fill: `url(#${patternId})`,
              stroke: colors[index],
              'stroke-width': 0.5,
            });
            bar.appendChild(
              svgNode(
                'title',
                {},
                `${series.label} · ${block.labels[point]}: ${format.format(value)}`,
              ),
            );
            svg.appendChild(bar);
          });
        }
      });
      canvas.appendChild(svg);
    }
    let resizeFrame: number | null = null;
    let observer: ResizeObserver | undefined;
    let stopped = false;
    const stopResize = () => {
      if (stopped) return;
      stopped = true;
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
      observer?.disconnect();
    };
    const resizeChart = () => {
      if (stopped) return;
      if (!canvas.isConnected) {
        stopResize();
        return;
      }
      // SVG replacement changes container height. Never mutate during observer
      // delivery; native error handling treats a resize loop as a widget failure.
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (stopped) return;
        if (!canvas.isConnected) {
          stopResize();
          return;
        }
        const measured = canvas.clientWidth || canvas.getBoundingClientRect().width;
        // Hidden panels measure zero. Retain their data/state until displayed.
        if (!panel.hidden && measured > 0 && canvasWidth() !== drawnWidth) draw();
      });
    };
    controller.onShow = resizeChart;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(resizeChart);
      observer.observe(canvas);
    }
    window.addEventListener('pagehide', stopResize, { once: true });
    const data = make('details');
    data.appendChild(make('summary', l.dataTable));
    const wrapper = make('div', '', 'ui-table-wrap');
    const table = make('table');
    table.appendChild(make('caption', block.title));
    const head = make('thead');
    const header = make('tr');
    [l.category, ...block.series.map(series => series.label)].forEach(label => {
      const cell = make('th', label);
      cell.scope = 'col';
      header.appendChild(cell);
    });
    head.appendChild(header);
    const body = make('tbody');
    table.append(head, body);
    wrapper.appendChild(table);
    data.appendChild(wrapper);
    let dataPage = 0;
    const updatePager = pager(
      data,
      () => block.labels.length,
      () => dataPage,
      value => {
        dataPage = value;
        updateData();
      },
    );
    function updateData(): void {
      body.replaceChildren();
      block.labels.slice(dataPage * 5, dataPage * 5 + 5).forEach((label, offset) => {
        const index = dataPage * 5 + offset;
        const row = make('tr');
        const category = make('th', label);
        category.scope = 'row';
        row.appendChild(category);
        block.series.forEach(series =>
          row.appendChild(make('td', format.format(series.values[index]))),
        );
        body.appendChild(row);
      });
      updatePager();
    }
    panel.appendChild(data);
    controller.values = () =>
      block.series.map((series, index) => ({
        id: series.id,
        label: seriesButtons[index].textContent || series.label,
        value: visible.has(series.id),
      }));
    draw();
    updateData();
  }

  function validate(state: FieldState, show: boolean): boolean {
    const { field, input } = state;
    let problem = '';
    if (field.type === 'checkbox') {
      state.value = (input as HTMLInputElement).checked;
      if (field.required && !state.value) problem = l.checkboxError;
    } else if (field.type === 'number') {
      const numeric = input as HTMLInputElement;
      const value = numeric.value === '' ? null : numeric.valueAsNumber;
      state.value = value === null || Number.isFinite(value) ? value : null;
      if (numeric.validity.badInput || (value !== null && !Number.isFinite(value)))
        problem = l.numberError;
      else if (value === null && field.required) problem = l.requiredError;
      else if (
        value !== null &&
        (Math.abs(value) > 1e12 ||
          (field.min !== undefined && value < field.min) ||
          (field.max !== undefined && value > field.max))
      )
        problem = l.rangeError;
    } else {
      state.value = input.value;
      if (field.type === 'select') {
        if (!field.options.includes(input.value)) problem = l.selectError;
      } else if (field.required && !input.value.trim()) problem = l.requiredError;
      else if (input.value.length > field.maxLength) problem = l.lengthError;
    }
    state.problem = problem;
    if (show) {
      state.error.textContent = problem;
      state.input.setAttribute('aria-invalid', String(Boolean(problem)));
    }
    return !problem;
  }

  function setupForm(block: Extract<UiBlock, { type: 'form' }>, controller: Controller): void {
    const ownFields: FieldState[] = [];
    block.fields.forEach(field => {
      const wrapper = make('div', '', 'ui-field');
      const label = make('label', field.label);
      const input =
        field.type === 'select'
          ? make('select')
          : field.type === 'text'
            ? make('textarea')
            : make('input');
      // Underscores are excluded by schema IDs, making all boundaries unambiguous.
      input.id = `ui_${block.id}_field_${field.id}`;
      label.htmlFor = input.id;
      if (field.type === 'select')
        field.options.forEach(value => {
          const option = make('option', value);
          option.value = value;
          input.appendChild(option);
        });
      if (input instanceof HTMLInputElement) {
        input.type =
          field.type === 'checkbox' ? 'checkbox' : field.type === 'number' ? 'number' : 'text';
        if (field.type === 'number') {
          input.step = 'any';
          input.min = String(field.min ?? -1e12);
          input.max = String(field.max ?? 1e12);
        }
        if (field.type === 'checkbox') input.checked = field.value;
        if (field.type !== 'select') input.required = field.required;
      }
      if (input instanceof HTMLTextAreaElement && field.type === 'text') {
        input.maxLength = field.maxLength;
        input.rows = 2;
        input.required = field.required;
      }
      if (field.type !== 'checkbox') input.value = field.value === null ? '' : String(field.value);
      if ('required' in field && field.required)
        label.appendChild(make('span', l.required, 'ui-required'));
      const error = make('p', '', 'ui-error');
      error.id = `${input.id}_error`;
      input.setAttribute('aria-describedby', error.id);
      input.setAttribute('aria-invalid', 'false');
      const state: FieldState = {
        field,
        input,
        error,
        controller,
        value: field.type === 'text' ? input.value : field.value,
        problem: '',
      };
      ownFields.push(state);
      fields.push(state);
      const changed = () => {
        validate(state, true);
        formStatus.textContent = fields.some(candidate => candidate.problem) ? l.invalid : '';
        refresh();
      };
      input.addEventListener('input', changed);
      input.addEventListener('change', changed);
      wrapper.append(label, input, error);
      controller.panel.appendChild(wrapper);
    });
    controller.values = () =>
      ownFields.map(state => ({
        id: state.field.id,
        label: state.field.label,
        value: state.value,
      }));
  }

  function setupSteps(block: Extract<UiBlock, { type: 'steps' }>, controller: Controller): void {
    const details = block.items.map((item, index) => {
      const detail = make('details');
      detail.append(make('summary', `${index + 1}. ${item.title}`), make('p', item.body));
      controller.panel.appendChild(detail);
      return detail;
    });
    exclusiveDetails(details, `ui_${block.id}_steps`, refresh);
    controller.values = () =>
      block.items.map((item, index) => ({
        id: `step-${index + 1}`,
        label: item.title,
        value: details[index].open,
      }));
  }

  doc.blocks.forEach((block, index) => {
    const panel = make('section', '', 'ui-panel');
    panel.id = `ui_${block.id}_panel`;
    const heading = make('h3', block.title);
    heading.id = `ui_${block.id}_heading`;
    panel.setAttribute('aria-labelledby', heading.id);
    panel.appendChild(heading);
    if (block.note) panel.appendChild(make('p', block.note, 'ui-note'));
    const switchButton = button(block.title);
    switchButton.setAttribute('aria-controls', panel.id);
    switchButton.setAttribute('aria-pressed', String(index === 0));
    switchButton.addEventListener('click', () => showPanel(index));
    nav.appendChild(switchButton);
    const controller: Controller = { block, panel, button: switchButton, values: () => [] };
    controllers.push(controller);
    root.appendChild(panel);
    switch (block.type) {
      case 'table':
        setupTable(block, controller);
        break;
      case 'compare':
        setupCompare(block, controller);
        break;
      case 'chart':
        setupChart(block, controller);
        break;
      case 'form':
        setupForm(block, controller);
        break;
      case 'steps':
        setupSteps(block, controller);
        break;
    }
  });
  root.appendChild(footer);
  showPanel(activePanel);
  refresh();

  function availability(): void {
    follow.disabled = !draftAvailable || pending;
    follow.textContent = draftAvailable ? l.follow : l.unavailable;
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'openclaw:scenario-draft-policy')
      return;
    draftAvailable =
      event.data.available === true && typeof host.openclaw?.prompt?.send === 'function';
    availability();
  });
  follow.addEventListener('click', event => {
    if (!event.isTrusted || !draftAvailable || pending) return;
    fields.forEach(state => validate(state, true));
    const invalid = fields.find(state => state.problem);
    if (invalid) {
      formStatus.textContent = l.invalid;
      showPanel(controllers.indexOf(invalid.controller));
      invalid.input.focus();
      return;
    }
    formStatus.textContent = '';
    const draft = draftFor(snapshots());
    // Final UTF-16 bound is checked after JSON escaping, before the private port.
    if (draft.text.length > 3600 || typeof host.openclaw?.prompt?.send !== 'function') return;
    pending = true;
    availability();
    try {
      void Promise.resolve(host.openclaw.prompt.send(draft.text))
        .then(
          accepted => {
            if (accepted === false) draftAvailable = false;
          },
          () => {
            draftAvailable = false;
          },
        )
        .finally(() => {
          pending = false;
          availability();
        });
    } catch {
      pending = false;
      draftAvailable = false;
      availability();
    }
  });
  root.setAttribute('data-interactive-ui-ready', 'true');
}
