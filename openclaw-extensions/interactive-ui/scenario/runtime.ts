import type { scenarioLabels } from './labels';
import type { calculateScenario, Scenario } from './schema';

type Boot = { scenario: Scenario; labels: typeof scenarioLabels.zh; promptGranted: boolean };

/** Serialized as one fixed renderer resource; keep all runtime helpers inside. */
export function scenarioRuntime(boot: Boot, calculate: typeof calculateScenario): void {
  const { scenario, labels } = boot;
  let people = scenario.people;
  let focus = scenario.focus;
  const locale = scenario.language === 'zh' ? 'zh-CN' : 'en-US';
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'CNY',
      maximumFractionDigits: 0,
    }).format(value);
  const element = (id: string) => document.getElementById(id)!;
  const teamInput = element('team') as HTMLInputElement;
  const focusInput = element('focus') as HTMLInputElement;
  const plans = [
    { id: 'lean', people: 3, focus: 5 },
    { id: 'balanced', people: 6, focus: 6 },
    { id: 'fast', people: 10, focus: 7 },
  ];
  let selected = plans.find(plan => plan.people === people && plan.focus === focus)?.id ?? '';
  const labelsByPlan: Record<string, string> = {
    lean: labels.lean,
    balanced: labels.balanced,
    fast: labels.fast,
  };
  const svg = (peopleCount: number, focusHours: number, color: string, maximumDays: number) => {
    const result = calculate(scenario, peopleCount, focusHours);
    const points = Array.from({ length: 25 }, (_, index) => {
      const day = (maximumDays * index) / 24;
      return `${42 + index * 24},${190 - Math.min(1, (day * result.capacity) / result.effort) * 156}`;
    });
    return `<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>`;
  };
  function update(): void {
    const result = calculate(scenario, people, focus);
    teamInput.value = String(people);
    focusInput.value = String(focus);
    element('team-value').textContent = `${people} ${labels.people}`;
    element('focus-value').textContent = `${focus} ${labels.hours}`;
    element('duration-value').textContent = String(result.days);
    element('cost-value').textContent = money(result.cost);
    element('capacity-value').textContent = result.capacity.toFixed(1);
    element('budget-status').textContent =
      result.cost <= scenario.budget ? labels.within : labels.beyond;
    element('budget-status').className =
      result.cost <= scenario.budget ? 'status good' : 'status over';
    element('deadline-status').textContent =
      result.days <= scenario.deadline ? labels.within : labels.beyond;
    element('deadline-status').className =
      result.days <= scenario.deadline ? 'status good' : 'status over';
    document.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach(button => {
      const active = button.dataset.plan === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    const maxDays = Math.max(
      scenario.deadline,
      ...plans.map(plan => calculate(scenario, plan.people, plan.focus).days),
      result.days,
    );
    element('chart-lines').innerHTML =
      plans
        .map((plan, index) =>
          svg(plan.people, plan.focus, ['#b5b9bd', '#419c86', '#dda65c'][index], maxDays),
        )
        .join('') + svg(people, focus, '#7d8bd5', maxDays);
    element('chart-end').textContent = `${maxDays} ${labels.days}`;
    element('chart-description').textContent =
      `${labels.selected}: ${result.days} ${labels.days}, ${money(result.cost)}`;
  }
  plans.forEach(plan => {
    const result = calculate(scenario, plan.people, plan.focus);
    const row = document.createElement('tr');
    for (const value of [
      labelsByPlan[plan.id],
      `${plan.people} ${labels.people}`,
      `${plan.focus} ${labels.hours}`,
      `${result.days} ${labels.days}`,
      money(result.cost),
    ]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    }
    element('comparison-body').appendChild(row);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach(button =>
    button.addEventListener('click', () => {
      const plan = plans.find(item => item.id === button.dataset.plan)!;
      selected = plan.id;
      people = plan.people;
      focus = plan.focus;
      update();
    }),
  );
  teamInput.addEventListener('input', () => {
    people = Number(teamInput.value);
    selected = '';
    update();
  });
  focusInput.addEventListener('input', () => {
    focus = Number(focusInput.value);
    selected = '';
    update();
  });
  const follow = element('follow') as HTMLButtonElement;
  const host = globalThis as typeof globalThis & {
    openclaw?: { prompt?: { send?: (value: string) => unknown } };
  };
  let draftAvailable = false;
  const updateDraftAvailability = () => {
    follow.disabled = !draftAvailable;
    follow.textContent = draftAvailable ? `${labels.follow} →` : labels.unavailable;
  };
  // Function presence alone does not prove the private prompt port is mounted.
  // This signal is display policy; the host still owns admission of every draft.
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.type !== 'openclaw:scenario-draft-policy')
      return;
    draftAvailable =
      event.data.available === true && typeof host.openclaw?.prompt?.send === 'function';
    updateDraftAvailability();
  });
  updateDraftAvailability();
  follow.addEventListener('click', event => {
    if (!event.isTrusted || !draftAvailable) return;
    const result = calculate(scenario, people, focus);
    const draft = `${labels.draft}\n${scenario.summary}\n${labels.team}: ${people}; ${labels.focus}: ${focus} ${labels.hours}; ${labels.duration}: ${result.days} ${labels.days}; ${labels.cost}: ${money(result.cost)}.\n${labels.assumption}`;
    // Inline prompt admission belongs to the canonical private bridge. The
    // compose flag describes dashboard grants and is always false inline.
    void Promise.resolve(host.openclaw?.prompt?.send?.(draft)).then(
      accepted => {
        if (accepted === false) {
          draftAvailable = false;
          updateDraftAvailability();
        }
      },
      () => {
        draftAvailable = false;
        updateDraftAvailability();
      },
    );
  });
  update();
  document.getElementById('scenario-explorer-loading')?.remove();
  document
    .getElementById('scenario-explorer-root')
    ?.setAttribute('data-interactive-ui-ready', 'true');
}
