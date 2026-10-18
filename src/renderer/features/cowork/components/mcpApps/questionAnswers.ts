import type { NativeAppQuestion } from '@shared/plugins/mcpApps';

type Field = NativeAppQuestion['questions'][number];
const optionValues = (field: Field) =>
  new Set(field.options.map(option => option.value ?? option.label));

export function freeQuestionAnswers(field: Field, answers: string[]): string[] {
  const options = optionValues(field);
  return answers.filter(value => !options.has(value));
}

/** Editing "Other" preserves checked options; a radio custom answer replaces its option. */
export function mergeFreeQuestionAnswers(
  field: Field,
  previous: string[],
  values: string[],
): string[] {
  const options = optionValues(field);
  const free = options.size ? values.filter(value => value !== '') : values;
  const selected = previous.filter(value => options.has(value));
  return !field.multiSelect && free.length ? free : [...selected, ...free];
}
