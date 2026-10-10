export const SCENARIO_KIND = 'scenario-explorer';
export const SCENARIO_RESOURCE = '/__interactive_ui__/scenario.js';
export const MAX_SOURCE_BYTES = 32_768;

export type Scenario = {
  version: 1;
  language: 'zh' | 'en';
  summary: string;
  tasks: { label: string; hours: number }[];
  dailyRate: number;
  budget: number;
  deadline: number;
  people: number;
  focus: number;
};

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !keys.includes(key)) || keys.some(key => !(key in data))) {
    throw new Error('Unexpected or missing field');
  }
  return data;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error('Invalid text');
  return value.trim();
}

function number(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error('Invalid integer');
  }
  return value;
}

export function parseScenario(source: string): Scenario {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES)
    throw new Error('Source too large');
  const data = record(JSON.parse(source), [
    'version',
    'language',
    'summary',
    'tasks',
    'dailyRate',
    'budget',
    'deadline',
    'people',
    'focus',
  ]);
  if (data.version !== 1 || (data.language !== 'zh' && data.language !== 'en'))
    throw new Error('Unsupported version or language');
  if (!Array.isArray(data.tasks) || data.tasks.length < 1 || data.tasks.length > 12)
    throw new Error('Invalid tasks');
  return {
    version: 1,
    language: data.language,
    summary: text(data.summary, 400),
    tasks: data.tasks.map(task => {
      const item = record(task, ['label', 'hours']);
      return { label: text(item.label, 80), hours: number(item.hours, 1, 2000) };
    }),
    dailyRate: number(data.dailyRate, 100, 5000),
    budget: number(data.budget, 5000, 1_000_000),
    deadline: number(data.deadline, 1, 365),
    people: number(data.people, 2, 12),
    focus: number(data.focus, 2, 8),
  };
}

/** Fixed demonstrative model; no user-authored expressions. */
export function calculateScenario(
  scenario: Scenario,
  people = scenario.people,
  focus = scenario.focus,
) {
  const effort = scenario.tasks.reduce((sum, task) => sum + task.hours, 0);
  const capacity = people * focus * 0.82 * (1 - 0.025 * (people - 1));
  const days = Math.ceil(effort / capacity);
  return { effort, capacity, days, cost: days * people * scenario.dailyRate };
}
