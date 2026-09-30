import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const DROPDOWN_GAP = 4;
const DROPDOWN_MAX_HEIGHT = 240;
const DROPDOWN_VIEWPORT_PADDING = 8;

type DropdownLayout = {
  bottom?: number;
  left: number;
  maxHeight: number;
  top?: number;
  width: number;
};

const getScrollBoundary = (element: HTMLElement) => {
  let parent = element.parentElement;
  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      const rect = parent.getBoundingClientRect();
      return {
        top: Math.max(DROPDOWN_VIEWPORT_PADDING, rect.top),
        bottom: Math.min(window.innerHeight - DROPDOWN_VIEWPORT_PADDING, rect.bottom),
      };
    }
    parent = parent.parentElement;
  }

  return {
    top: DROPDOWN_VIEWPORT_PADDING,
    bottom: window.innerHeight - DROPDOWN_VIEWPORT_PADDING,
  };
};

interface ThemedSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  className?: string;
  label?: string;
  ariaLabel?: string;
  disabled?: boolean;
  leadingIcon?: React.ReactNode;
  menuMinWidth?: number;
  title?: string;
  highlightSelected?: boolean;
}

const ThemedSelect: React.FC<ThemedSelectProps> = ({
  id,
  value,
  onChange,
  options,
  className = '',
  label,
  ariaLabel,
  disabled = false,
  leadingIcon,
  menuMinWidth = 0,
  title,
  highlightSelected = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropdownLayout, setDropdownLayout] = useState<DropdownLayout | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Find the selected option label
  const selectedOption = options.find(option => option.value === value);
  const selectedIndex = options.findIndex(option => option.value === value);
  const firstEnabledIndex = options.findIndex(option => !option.disabled);
  const lastEnabledIndex = options.reduce(
    (last, option, index) => (option.disabled ? last : index),
    -1,
  );

  const openDropdown = () => {
    if (disabled || firstEnabledIndex < 0) return;
    setActiveIndex(
      selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : firstEnabledIndex,
    );
    setIsOpen(true);
  };

  const closeDropdown = (restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        closeDropdown();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const updateDropdownLayout = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const boundary = getScrollBoundary(button);
    if (rect.bottom <= boundary.top || rect.top >= boundary.bottom) {
      closeDropdown();
      return;
    }

    const desiredHeight = Math.min(DROPDOWN_MAX_HEIGHT, options.length * 32 + 8);
    const spaceAbove = Math.max(0, rect.top - boundary.top - DROPDOWN_GAP);
    const spaceBelow = Math.max(0, boundary.bottom - rect.bottom - DROPDOWN_GAP);
    const opensUpward = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
    const availableHeight = opensUpward ? spaceAbove : spaceBelow;

    if (availableHeight < 32) {
      closeDropdown(true);
      return;
    }

    const width = Math.min(
      Math.max(rect.width, menuMinWidth),
      window.innerWidth - DROPDOWN_VIEWPORT_PADDING * 2,
    );
    setDropdownLayout({
      left: Math.min(
        Math.max(DROPDOWN_VIEWPORT_PADDING, rect.left),
        window.innerWidth - width - DROPDOWN_VIEWPORT_PADDING,
      ),
      width,
      maxHeight: Math.min(DROPDOWN_MAX_HEIGHT, availableHeight),
      ...(opensUpward
        ? { bottom: window.innerHeight - rect.top + DROPDOWN_GAP }
        : { top: rect.bottom + DROPDOWN_GAP }),
    });
  }, [menuMinWidth, options.length]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setDropdownLayout(null);
      return;
    }

    updateDropdownLayout();
    window.addEventListener('resize', updateDropdownLayout);
    window.addEventListener('scroll', updateDropdownLayout, true);
    return () => {
      window.removeEventListener('resize', updateDropdownLayout);
      window.removeEventListener('scroll', updateDropdownLayout, true);
    };
  }, [isOpen, updateDropdownLayout]);

  useLayoutEffect(() => {
    if (!isOpen || activeIndex < 0) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, isOpen]);

  // Handle option selection
  const handleOptionClick = (optionValue: string) => {
    if (options.find(option => option.value === optionValue)?.disabled) return;
    onChange(optionValue);
    closeDropdown(true);
  };

  const handleButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!isOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        openDropdown();
        if (event.key === 'ArrowUp') setActiveIndex(lastEnabledIndex);
      }
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(current => {
        for (let offset = 1; offset <= options.length; offset += 1) {
          const next = (current + direction * offset + options.length) % options.length;
          if (!options[next].disabled) return next;
        }
        return -1;
      });
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? firstEnabledIndex : lastEnabledIndex);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) handleOptionClick(option.value);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDropdown(true);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="flex items-center space-x-3">
        {label && (
          <label htmlFor={id} className="text-sm font-medium text-foreground whitespace-nowrap">
            {label}
          </label>
        )}
        <div className="flex-1">
          <button
            ref={buttonRef}
            id={id}
            type="button"
            role="combobox"
            disabled={disabled || options.length === 0}
            title={title}
            onClick={() => (isOpen ? closeDropdown() : openDropdown())}
            onKeyDown={handleButtonKeyDown}
            onBlur={() => closeDropdown()}
            className={`flex items-center justify-between w-full rounded-lg bg-surface border-border border focus:border-primary focus:ring-1 focus:ring-primary/40 text-foreground px-4 py-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
            aria-haspopup="listbox"
            aria-label={ariaLabel}
            aria-expanded={isOpen}
            aria-controls={`${id}-listbox`}
            aria-activedescendant={
              isOpen && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined
            }
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {leadingIcon}
              <span className="truncate">{selectedOption?.label || value}</span>
            </span>
            <ChevronDownIcon className="ml-2 h-3 w-3 shrink-0 text-secondary" />
          </button>

          {isOpen &&
            dropdownLayout &&
            createPortal(
              <div
                ref={menuRef}
                className="fixed z-[100] overflow-auto rounded-lg border border-border bg-surface shadow-popover popover-enter focus:outline-none"
                style={dropdownLayout}
              >
                <ul
                  id={`${id}-listbox`}
                  className="py-1 text-sm"
                  role="listbox"
                  aria-labelledby={id}
                >
                  {options.map((option, index) => (
                    <li
                      id={`${id}-option-${index}`}
                      data-option-index={index}
                      key={option.value}
                      className={`select-none relative py-1.5 pl-3 pr-9 ${option.disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-surface-raised'} ${
                        index === activeIndex || (highlightSelected && option.value === value)
                          ? 'bg-surface-raised'
                          : ''
                      }`}
                      role="option"
                      aria-selected={option.value === value}
                      aria-disabled={option.disabled || undefined}
                      onMouseDown={event => event.preventDefault()}
                      onMouseEnter={() => {
                        if (!option.disabled) setActiveIndex(index);
                      }}
                      onClick={() => handleOptionClick(option.value)}
                    >
                      <span
                        className={`block truncate text-foreground ${
                          option.value === value ? 'font-medium' : 'font-normal'
                        }`}
                      >
                        {option.label}
                      </span>
                      {highlightSelected && option.value === value && (
                        <CheckIcon className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary" />
                      )}
                    </li>
                  ))}
                </ul>
              </div>,
              document.body,
            )}
        </div>
      </div>
    </div>
  );
};

export default ThemedSelect;
