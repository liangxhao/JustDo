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
  test('keeps unavailable models visible and focusable without selecting them', () => {
    const models: Model[] = [
      { id: 'ready', name: 'Ready model', providerKey: 'custom_0', provider: 'Acme' },
      {
        id: 'unavailable',
        name: 'Unavailable model',
        providerKey: 'custom_0',
        provider: 'Acme',
        available: false,
        unavailableReason: 'missing-auth',
      },
    ];
    const { onChange, onOpen } = renderSelector(models);

    fireEvent.click(screen.getByRole('button', { name: 'Ready model' }));

    const unavailableButton = screen.getByText('Unavailable model').closest('button');
    expect(unavailableButton?.getAttribute('aria-disabled')).toBe('true');
    expect(unavailableButton?.hasAttribute('disabled')).toBe(false);
    fireEvent.click(unavailableButton!);
    expect(onChange).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  test('selects an available model and reports runtime metadata', () => {
    const models: Model[] = [
      { id: 'current', name: 'Current model', providerKey: 'custom_0', provider: 'Acme' },
      {
        id: 'next',
        name: 'Next model',
        providerKey: 'custom_0',
        provider: 'Acme',
        contextLength: 128_000,
        reasoning: true,
        supportsTools: false,
      },
    ];
    const { onChange } = renderSelector(models);
    fireEvent.click(screen.getByRole('button', { name: 'Current model' }));

    fireEvent.click(screen.getByText('Next model'));

    expect(onChange).toHaveBeenCalledWith(models[1]);
  });
});
