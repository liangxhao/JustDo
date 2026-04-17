import React, { useState, useEffect, useRef } from 'react';
import type { SessionGroup, UpdateGroupInput } from '../../types/cowork';
import { GROUP_COLORS } from '../../types/cowork';
import Modal from '../common/Modal';
import { i18nService } from '../../services/i18n';

interface EditGroupModalProps {
  isOpen: boolean;
  group: SessionGroup | null;
  onClose: () => void;
  onUpdate: (id: string, input: UpdateGroupInput) => void;
}

const EditGroupModal: React.FC<EditGroupModalProps> = ({ isOpen, group, onClose, onUpdate }) => {
  const [name, setName] = useState('');
  const [color, setColor] = useState(GROUP_COLORS[5]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && group) {
      setName(group.name);
      setColor(group.color);
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  }, [isOpen, group]);

  const handleUpdate = () => {
    if (group && name.trim()) {
      const updates: UpdateGroupInput = {};
      if (name.trim() !== group.name) {
        updates.name = name.trim();
      }
      if (color !== group.color) {
        updates.color = color;
      }
      if (Object.keys(updates).length > 0) {
        onUpdate(group.id, updates);
      }
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleUpdate();
    }
  };

  if (!isOpen || !group) return null;

  return (
    <Modal
      onClose={onClose}
      className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-xl overflow-hidden"
    >
      <div className="px-5 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">{i18nService.t('editGroup')}</h2>
      </div>
      <div className="edit-group-form px-5 py-4">
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
          onClick={handleUpdate}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-primary hover:bg-primary-hover text-white transition-colors"
        >
          {i18nService.t('save')}
        </button>
      </div>
    </Modal>
  );
};

export default EditGroupModal;
