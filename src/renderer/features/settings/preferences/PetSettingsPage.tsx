import type { AppearanceConfig } from '@/app/appearance';
import { i18nService } from '@/services/i18n';

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

const PetSettingRow = ({ title, description, checked, onChange }: PetSettingRowProps) => (
  <div className="flex flex-col gap-3 border-t border-border px-4 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
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
  return (
    <div className="space-y-4">
      <p className="text-sm leading-6 text-secondary">
        {i18nService.t('coworkPetSettingsDescription')}
      </p>
      <section className="overflow-hidden rounded-xl border border-border bg-surface">
        <PetSettingRow
          title={i18nService.t('coworkPetShow')}
          description={i18nService.t('coworkPetShowDescription')}
          checked={value.petEnabled}
          onChange={petEnabled => onChange({ ...value, petEnabled })}
        />
        <PetSettingRow
          title={i18nService.t('coworkPetAnimation')}
          description={i18nService.t('coworkPetAnimationDescription')}
          checked={value.petAnimationEnabled}
          onChange={petAnimationEnabled => onChange({ ...value, petAnimationEnabled })}
        />
      </section>
    </div>
  );
}
