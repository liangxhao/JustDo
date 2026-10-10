import { widgetResourceBootstrap } from '../document/resource-bootstrap';
import { escapeHtml, scriptJson } from '../document/serialization';
import { scenarioLabels } from './labels';
import { scenarioRuntime } from './runtime';
import { calculateScenario, parseScenario, SCENARIO_KIND, SCENARIO_RESOURCE } from './schema';
import { scenarioStyles } from './styles';

export function scenarioRendererSource(): string {
  return `(${scenarioRuntime.toString()})(globalThis.__scenarioBoot,(${calculateScenario.toString()}));`;
}

export const scenarioContentKind = {
  kind: SCENARIO_KIND,
  label: 'Scenario explorer',
  resources: {
    surface: 'interactive-ui',
    paths: [SCENARIO_RESOURCE],
    async readPublicResource(path: string) {
      if (path !== SCENARIO_RESOURCE) return undefined;
      return {
        body: new TextEncoder().encode(scenarioRendererSource()),
        contentType: 'text/javascript; charset=utf-8',
      };
    },
  },
  validateSource(source: string): void {
    parseScenario(source);
  },
  composeDocument({
    source,
    resourceUrls,
    promptGranted,
  }: {
    source: string;
    title: string;
    resourceUrls: Readonly<Record<string, string>>;
    promptGranted: boolean;
  }): string {
    const scenario = parseScenario(source);
    const l = scenarioLabels[scenario.language];
    const url = resourceUrls[SCENARIO_RESOURCE];
    if (!url) throw new Error('Scenario renderer resource unavailable');
    return `<style>${scenarioStyles}</style><main id="scenario-explorer-root" lang="${scenario.language}">
      <p id="scenario-explorer-loading" role="status">${escapeHtml(l.rendererLoading)}</p>
      <p class="eyebrow">${l.eyebrow}</p><h2>${escapeHtml(scenario.summary)}</h2><p class="intro">${l.intro}</p>
      <div class="plans">${(['lean', 'balanced', 'fast'] as const).map(plan => `<button type="button" data-plan="${plan}" aria-pressed="false">${l[plan]}</button>`).join('')}</div>
      <div class="controls"><label><span class="control-label">${l.team}<output id="team-value"></output></span><input id="team" type="range" min="2" max="12" value="${scenario.people}" aria-label="${l.team}"></label><label><span class="control-label">${l.focus}<output id="focus-value"></output></span><input id="focus" type="range" min="2" max="8" value="${scenario.focus}" aria-label="${l.focus}"></label></div>
      <div class="metrics" aria-live="polite"><div class="metric"><p>${l.duration}</p><strong id="duration-value"></strong><small>${l.days}</small></div><div class="metric"><p>${l.cost}</p><strong id="cost-value"></strong><small>CNY</small></div><div class="metric"><p>${l.capacity}</p><strong id="capacity-value"></strong><small>${l.hours}</small></div></div>
      <div class="targets"><span>${l.budget}: ¥${scenario.budget.toLocaleString()}<span id="budget-status"></span></span><span>${l.deadline}: ${scenario.deadline} ${l.days}<span id="deadline-status"></span></span></div>
      <section class="chart"><h3>${l.progress}</h3><svg viewBox="0 0 650 230" role="img" aria-label="${l.chartLabel}"><title id="chart-description"></title><path class="grid-line" d="M42 34H618M42 112H618M42 190H618"/><text class="chart-label" x="5" y="38">100%</text><text class="chart-label" x="12" y="116">50%</text><text class="chart-label" x="18" y="194">0%</text><g id="chart-lines"></g><text class="chart-label" x="42" y="216">0</text><text class="chart-label" id="chart-end" x="618" y="216" text-anchor="end"></text></svg><div class="legend"><span style="--dot:#b5b9bd">${l.lean}</span><span style="--dot:#419c86">${l.balanced}</span><span style="--dot:#dda65c">${l.fast}</span><span style="--dot:#7d8bd5">${l.selected}</span></div></section>
      <h3>${l.comparison}</h3><table><thead><tr><th>${l.plan}</th><th>${l.team}</th><th>${l.focus}</th><th>${l.timeline}</th><th>${l.cost}</th></tr></thead><tbody id="comparison-body"></tbody></table>
      <div class="bottom"><p class="assumption">${l.dailyRate}: ¥${scenario.dailyRate} · ${l.assumption}</p><button id="follow" type="button" disabled>${l.follow} →</button></div>
      <details class="task-details"><summary>${l.tasks}</summary><ul>${scenario.tasks.map(task => `<li>${escapeHtml(task.label)} · ${task.hours} ${l.hours}</li>`).join('')}</ul></details>
      </main><script>globalThis.__scenarioBoot=${scriptJson({ scenario, labels: l, promptGranted })};\n(${widgetResourceBootstrap.toString()})(${scriptJson({ rootId: 'scenario-explorer-root', rendererId: 'scenario-explorer-renderer', unavailable: l.rendererUnavailable })});</script><script id="scenario-explorer-renderer" src="${escapeHtml(url)}"></script>`;
  },
};
