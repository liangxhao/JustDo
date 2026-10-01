import './PetSettingsPage.css';

import type { AppearanceConfig, PetCatSelection } from '@/app/appearance';
import { PET_FLOATING_POSITION_KEY, PET_FLOATING_RESET_EVENT } from '@/app/petFloating';
import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

import petSpriteUrl from '../../../../../resources/pets/black-white-cats/spritesheet.png';

interface PetSettingsPageProps {
  value: AppearanceConfig;
  onChange: (value: AppearanceConfig) => void;
}

interface PetSettingRowProps {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

interface PetChoiceRowProps<T extends string> {
  title: string;
  description: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

function PetChoiceRow<T extends string>({ title, description, value, options, onChange }: PetChoiceRowProps<T>) {
  return (
    <div className="pet-settings-row pet-settings-row--choice">
      <div className="min-w-0 pr-4">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <p className="mt-1 text-xs leading-5 text-secondary">{description}</p>
      </div>
      <div className="pet-settings-select-wrap">
        <ThemedSelect
          id={`pet-${title}`}
          ariaLabel={title}
          value={value}
          options={[...options]}
          onChange={nextValue => {
            const selected = options.find(option => option.value === nextValue);
            if (selected) onChange(selected.value);
          }}
          className="pet-settings-select"
          highlightSelected
        />
      </div>
    </div>
  );
}

const PetSettingRow = ({ title, description, checked, onChange }: PetSettingRowProps) => (
  <div className="pet-settings-row">
    <div className="min-w-0 pr-4">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <p className="mt-1 text-xs leading-5 text-secondary">{description}</p>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={title}
      onClick={() => onChange(!checked)}
      className={`ml-auto flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 shadow-inner transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${checked ? 'bg-primary' : 'bg-border'}`}
    >
      <span className={`h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  </div>
);

export function PetSettingsPage({ value, onChange }: PetSettingsPageProps) {
  const catOptions: readonly { value: PetCatSelection; label: string }[] = [
    { value: 'white', label: i18nService.t('coworkPetWhiteCat') },
    { value: 'black', label: i18nService.t('coworkPetBlackCat') },
    { value: 'both', label: i18nService.t('coworkPetBothCats') },
  ];
  return (
    <div className="pet-settings-page">
      <section className="pet-settings-card pet-settings-card--selection">
        <div className="pet-settings-card__heading">
          <h3 id="pet-cat-selection-title" className="text-sm font-semibold text-foreground">
            {i18nService.t('coworkPetCats')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('coworkPetSettingsDescription')}
          </p>
        </div>
        <div role="radiogroup" aria-labelledby="pet-cat-selection-title" className="pet-choice-grid">
          {catOptions.map(option => (
            <label
              key={option.value}
              className={`pet-choice-card${value.petCatSelection === option.value ? ' pet-choice-card--selected' : ''}`}
            >
              <input
                type="radio"
                name="pet-cat-selection"
                value={option.value}
                aria-label={option.label}
                checked={value.petCatSelection === option.value}
                onChange={() => onChange({ ...value, petCatSelection: option.value })}
                className="sr-only"
              />
              <span className="pet-choice-thumbnail" aria-hidden="true">
                <span
                  className={`pet-choice-thumbnail__sprite pet-choice-thumbnail__sprite--${option.value}`}
                  style={{ backgroundImage: `url(${petSpriteUrl})` }}
                />
              </span>
              {value.petCatSelection === option.value && (
                <span className="pet-choice-card__check" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none"><path d="m4 8 2.5 2.5L12 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </span>
              )}
            </label>
          ))}
        </div>
        <PetSettingRow
          title={i18nService.t('coworkPetShow')}
          description={i18nService.t('coworkPetShowDescription')}
          checked={value.petEnabled}
          onChange={petEnabled => onChange({ ...value, petEnabled })}
        />
      </section>
      <section className="pet-settings-card">
        <div className="pet-settings-card__heading">
          <h3 className="text-sm font-semibold text-foreground">{i18nService.t('coworkPetDisplayGroup')}</h3>
          <p className="mt-1 text-xs leading-5 text-secondary">{i18nService.t('coworkPetDisplayGroupDescription')}</p>
        </div>
        <PetSettingRow
          title={i18nService.t('coworkPetShowHome')}
          description={i18nService.t('coworkPetShowHomeDescription')}
          checked={value.petShowHome}
          onChange={petShowHome => onChange({ ...value, petShowHome })}
        />
        <PetSettingRow
          title={i18nService.t('coworkPetShowChat')}
          description={i18nService.t('coworkPetShowChatDescription')}
          checked={value.petShowChat}
          onChange={petShowChat => onChange({ ...value, petShowChat })}
        />
        <PetSettingRow
          title={i18nService.t('coworkPetFloating')}
          description={i18nService.t('coworkPetFloatingDescription')}
          checked={value.petFloatingEnabled}
          onChange={petFloatingEnabled => onChange({ ...value, petFloatingEnabled })}
        />
        <div className="pet-settings-card__footer">
          <button
            type="button"
            onClick={() => {
              window.localStorage.removeItem(PET_FLOATING_POSITION_KEY);
              window.dispatchEvent(new Event(PET_FLOATING_RESET_EVENT));
            }}
            className="pet-settings-reset"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M5 6.5A6 6 0 1 1 4 12M5 3v4H1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {i18nService.t('coworkPetResetPosition')}
          </button>
        </div>
      </section>
      <section className="pet-settings-card">
        <div className="pet-settings-card__heading">
          <h3 className="text-sm font-semibold text-foreground">{i18nService.t('coworkPetMotionGroup')}</h3>
          <p className="mt-1 text-xs leading-5 text-secondary">{i18nService.t('coworkPetMotionGroupDescription')}</p>
        </div>
        <PetSettingRow
          title={i18nService.t('coworkPetAnimation')}
          description={i18nService.t('coworkPetAnimationDescription')}
          checked={value.petAnimationEnabled}
          onChange={petAnimationEnabled => onChange({ ...value, petAnimationEnabled })}
        />
        <PetChoiceRow
          title={i18nService.t('coworkPetVariety')}
          description={i18nService.t('coworkPetVarietyDescription')}
          value={value.petVariety}
          options={([
            { value: 'classic', label: i18nService.t('coworkPetVarietyClassic') },
            { value: 'varied', label: i18nService.t('coworkPetVarietyVaried') },
            { value: 'playful', label: i18nService.t('coworkPetVarietyPlayful') },
          ] as const)}
          onChange={petVariety => onChange({ ...value, petVariety })}
        />
        <PetChoiceRow
          title={i18nService.t('coworkPetSpeed')}
          description={i18nService.t('coworkPetSpeedDescription')}
          value={value.petSpeed}
          options={([
            { value: 'calm', label: i18nService.t('coworkPetSpeedCalm') },
            { value: 'normal', label: i18nService.t('coworkPetSpeedNormal') },
            { value: 'lively', label: i18nService.t('coworkPetSpeedLively') },
          ] as const)}
          onChange={petSpeed => onChange({ ...value, petSpeed })}
        />
        <PetChoiceRow
          title={i18nService.t('coworkPetRestAfter')}
          description={i18nService.t('coworkPetRestAfterDescription')}
          value={value.petRestAfter}
          options={([
            { value: 'never', label: i18nService.t('coworkPetRestNever') },
            { value: 'short', label: i18nService.t('coworkPetRestShort') },
            { value: 'standard', label: i18nService.t('coworkPetRestStandard') },
            { value: 'long', label: i18nService.t('coworkPetRestLong') },
          ] as const)}
          onChange={petRestAfter => onChange({ ...value, petRestAfter })}
        />
      </section>
    </div>
  );
}
