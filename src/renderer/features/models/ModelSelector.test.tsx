// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, test, vi } from 'vitest';

import ModelSelector from './ModelSelector';
import modelReducer, { type Model } from './modelSlice';

afterEach(cleanup);

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
  test('keeps an unresolved selection visible and lets the user select a replacement', () => {
    const replacement = { id: 'replacement', name: 'Replacement', providerKey: 'builtin_models' };
    const onChange = vi.fn();
    const store = configureStore({ reducer: { model: modelReducer } });
    render(
      <Provider store={store}>
        <ModelSelector
          value={null}
          models={[replacement]}
          onChange={onChange}
          emptyLabel="原模型不可用，请重新选择"
        />
      </Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '原模型不可用，请重新选择' }));
    const builtin = screen.getByRole('group', { name: '内置模型' });
    fireEvent.click(within(builtin).getByRole('button', { name: 'Replacement' }));

    expect(onChange).toHaveBeenCalledWith(replacement);
  });

  test('shows a placeholder for an empty model name instead of a blank button', () => {
    const models = [{ id: 'new', name: 'New model', providerKey: 'builtin_models' }];
    const store = configureStore({ reducer: { model: modelReducer } });
    render(
      <Provider store={store}>
        <ModelSelector value={{ id: '', name: '' }} models={models} onChange={vi.fn()} />
      </Provider>,
    );

    expect(screen.getByRole('button', { name: '请选择模型' })).toBeTruthy();
  });

  test.each(['missing-auth', 'auth-failed', undefined] as const)(
    'allows selecting a configured model with runtime state %s',
    unavailableReason => {
      const models: Model[] = [
        { id: 'ready', name: 'Ready model', providerKey: 'custom_0', provider: 'Acme' },
        {
          id: 'unavailable',
          name: 'Unavailable model',
          providerKey: 'custom_0',
          provider: 'Acme',
          available: false,
          unavailableReason,
        },
      ];
      const { onChange, onOpen } = renderSelector(models);

      fireEvent.click(screen.getByRole('button', { name: 'Ready model' }));

      const group = screen.getByRole('group', { name: 'Acme' });
      const unavailableButton = within(group).getByRole('button', { name: 'Unavailable model' });
      expect(unavailableButton.getAttribute('aria-disabled')).toBeNull();
      expect(unavailableButton.getAttribute('title')).toBeNull();
      fireEvent.click(unavailableButton);
      expect(onChange).toHaveBeenCalledWith(models[1]);
      expect(onOpen).toHaveBeenCalledOnce();
    },
  );

  test('groups by provider identity and selects the correct model across groups', () => {
    const models: Model[] = [
      { id: 'shared', name: 'Shared model', providerKey: 'acme', provider: 'Acme' },
      { id: 'shared', name: 'Shared model', providerKey: 'acme-backup', provider: 'Acme' },
      {
        id: 'next',
        name: 'team/Next model',
        providerKey: 'acme',
        provider: 'Acme',
        supportsImage: true,
      },
    ];
    const { onChange } = renderSelector(models);
    const trigger = screen.getByRole('button', { name: 'Shared model' });
    fireEvent.click(trigger);

    const [firstGroup, secondGroup] = screen.getAllByRole('group', { name: 'Acme' });
    const firstOptions = within(firstGroup).getAllByRole('button');
    const secondOption = within(secondGroup).getByRole('button', { name: 'Shared model' });
    expect(firstOptions.map(option => option.textContent)).toEqual([
      'Shared model',
      'team/Next model',
    ]);
    expect(firstOptions[0].getAttribute('aria-current')).toBe('true');
    expect(secondOption.getAttribute('aria-current')).toBeNull();
    expect(within(firstOptions[1]).getByTitle('team/Next model')).toBeTruthy();
    expect(within(firstOptions[1]).getByRole('img', { name: '图像' })).toBeTruthy();

    fireEvent.click(secondOption);

    expect(onChange).toHaveBeenCalledWith(models[1]);
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('closes the menu and restores focus on Escape', () => {
    const models = [{ id: 'model', name: 'Example model', provider: 'Acme', providerKey: 'acme' }];
    const { onChange } = renderSelector(models);
    const trigger = screen.getByRole('button', { name: 'Example model' });
    fireEvent.click(trigger);

    const option = within(screen.getByRole('group', { name: 'Acme' })).getByRole('button', {
      name: 'Example model',
    });
    option.focus();
    fireEvent.keyDown(option, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
