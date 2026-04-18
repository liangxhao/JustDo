import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { CreateGroupInput } from '../../types/cowork';
import { GROUP_COLORS } from '../../types/cowork';
import Modal from '../common/Modal';
import { i18nService } from '../../services/i18n';

interface CreateGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (input: CreateGroupInput) => void;
  existingColors?: string[];
}

const getDefaultColor = (existingColors?: string[]): string => {
  const usedSet = new Set(existingColors?.map(c => c.toLowerCase()));
  for (const color of GROUP_COLORS) {
    if (!usedSet.has(color.toLowerCase())) {
      return color;
    }
  }
  return GROUP_COLORS[0];
};

const CreateGroupModal: React.FC<CreateGroupModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  existingColors,
}) => {
  const defaultColor = useMemo(() => getDefaultColor(existingColors), []);
  const [name, setName] = useState('');
  const [color, setColor] = useState(defaultColor);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setName('');
      setColor(getDefaultColor(existingColors));
    }
  }, [isOpen, existingColors]);

  const handleCreate = () => {
    if (name.trim()) {
      onCreate({ name: name.trim(), color });
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreate();
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      onClose={onClose}
      className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">{i18nService.t('createGroup')}</h2>
      </div>
      <div className="create-group-form px-5 py-4">
        <label className="form-label">{i18nService.t('groupName')}</label>
        <input
          ref={inputRef}
          type="text"
          className="form-input"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={i18nService.t('groupNamePlaceholder')}
        />

        <label className="form-label">{i18nService.t('groupColor')}</label>
        <div className="color-picker-row">
          {GROUP_COLORS.map(c => (
            <div
              key={c}
              className={`color-option ${color === c ? 'selected' : ''}`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          onClick={handleCreate}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-primary hover:bg-primary-hover text-white transition-colors"
        >
          {i18nService.t('create')}
        </button>
      </div>
    </Modal>
  );
};

export default CreateGroupModal;
