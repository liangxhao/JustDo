// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { describe, expect, test, vi } from 'vitest';

import ModelSelector from './ModelSelector';
import modelReducer, { type Model } from './modelSlice';

const renderSelector = (models: Model[], onChange = vi.fn(), onOpen = vi.fn()) => {
  const store = configureStore({ reducer: { model: modelReducer } });
  render(
    <Provider store={store}>
      <ModelSelector value={models[0]} models={models} onChange={onChange} onOpen={onOpen} />
    </Provider>,
  );
  return { onChange, onOpen };
};

describe('ModelSelector', () => {
  test('allows selecting models regardless of transient runtime availability', () => {
    const models: Model[] = [
      { id: 'ready', name: 'Ready model', providerKey: 'custom_0', provider: 'Acme' },
      {
        id: 'unavailable',
        name: 'Unavailable model',
        providerKey: 'custom_0',
        provider: 'Acme',
        available: false,
        unavailableReason: 'cooldown',
        unavailableUntil: Date.now() + 60_000,
      },
    ];
    const { onChange, onOpen } = renderSelector(models);

    fireEvent.click(screen.getByRole('button', { name: 'Ready model' }));

    const unavailableButton = screen.getByText('Unavailable model').closest('button');
    expect(unavailableButton?.getAttribute('aria-disabled')).toBeNull();
    expect(unavailableButton?.getAttribute('title')).toBeNull();
    expect(unavailableButton?.textContent).toBe('Acme/Unavailable model');
    fireEvent.click(unavailableButton!);
    expect(onChange).toHaveBeenCalledWith(models[1]);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test('renders the configured provider and complete model display name on one line', () => {
    const models: Model[] = [
      { id: 'current', name: 'Current model', providerKey: 'custom_0', provider: 'Acme' },
      {
        id: 'next',
        name: 'team/Next model',
        providerKey: 'custom_0',
        provider: 'Acme AI',
        contextLength: 128_000,
        reasoning: true,
        supportsTools: false,
        supportsImage: true,
      },
    ];
    const { onChange } = renderSelector(models);
    fireEvent.click(screen.getByRole('button', { name: 'Current model' }));

    const nextButton = screen.getByText('team/Next model').closest('button');
    expect(nextButton?.textContent).toBe('Acme AI/team/Next model');
    expect(screen.getByTitle('Acme AI/team/Next model')).toBeTruthy();
    expect(screen.getByLabelText('图像')).toBeTruthy();
    fireEvent.click(nextButton!);

    expect(onChange).toHaveBeenCalledWith(models[1]);
  });
});
