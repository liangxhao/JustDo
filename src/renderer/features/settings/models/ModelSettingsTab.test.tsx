// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LanguageModelSettingsProps } from './LanguageModelSettings';
import ModelSettingsTab from './ModelSettingsTab';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

vi.mock('./LanguageModelSettings', () => ({
  default: () => <div>language-model-settings</div>,
}));

vi.mock('./NonLanguageModelSettings', () => ({
  default: ({ kind }: { kind: string }) => (
    <div data-testid="non-language-panel">{`non-language-${kind}`}</div>
  ),
}));

afterEach(cleanup);

const languageSettings = {} as LanguageModelSettingsProps;
const nonLanguageSettings = {
  categories: {},
  setCategory: vi.fn(),
  setCategories: vi.fn(),
};

describe('ModelSettingsTab', () => {
  it('renders the language model settings as the default panel', () => {
    render(
      <ModelSettingsTab
        activeKind="language"
        onKindChange={vi.fn()}
        languageSettings={languageSettings}
        nonLanguageSettings={nonLanguageSettings}
      />,
    );

    expect(screen.getByText('language-model-settings')).toBeTruthy();
    expect(
      screen.getByRole('tab', { name: 'modelTypeLanguage' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('requests a model category change from the tab bar', () => {
    const onKindChange = vi.fn();
    render(
      <ModelSettingsTab
        activeKind="language"
        onKindChange={onKindChange}
        languageSettings={languageSettings}
        nonLanguageSettings={nonLanguageSettings}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'modelTypeSpeechRecognition' }));
    expect(onKindChange).toHaveBeenCalledWith('speech-recognition');
  });

  it('offers image and video generation categories', () => {
    const onKindChange = vi.fn();
    render(
      <ModelSettingsTab
        activeKind="video"
        onKindChange={onKindChange}
        languageSettings={languageSettings}
        nonLanguageSettings={nonLanguageSettings}
      />,
    );

    expect(screen.getByText('non-language-video')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'import' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'export' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'modelTypeImage' }));
    expect(onKindChange).toHaveBeenCalledWith('image');
  });

  it('remounts custom settings when the model category changes', () => {
    const { rerender } = render(
      <ModelSettingsTab
        activeKind="speech-recognition"
        onKindChange={vi.fn()}
        languageSettings={languageSettings}
        nonLanguageSettings={nonLanguageSettings}
      />,
    );
    const recognitionPanel = screen.getByTestId('non-language-panel');

    rerender(
      <ModelSettingsTab
        activeKind="image"
        onKindChange={vi.fn()}
        languageSettings={languageSettings}
        nonLanguageSettings={nonLanguageSettings}
      />,
    );

    expect(screen.getByTestId('non-language-panel')).not.toBe(recognitionPanel);
    expect(screen.getByText('non-language-image')).toBeTruthy();
  });
});
