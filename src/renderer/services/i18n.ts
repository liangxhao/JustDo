import { configService } from '@/services/config';
import { translations } from '@/services/i18n/translations';

export type LanguageType = 'zh' | 'en';

class I18nService {
  private currentLanguage: LanguageType = 'zh';
  private listeners = new Set<() => void>();

  async initialize(): Promise<void> {
    try {
      const config = configService.getConfig();
      if (config.language_initialized === true) {
        if (config.language === 'zh' || config.language === 'en') {
          this.currentLanguage = config.language;
        } else {
          this.currentLanguage = 'en';
          await configService.updateConfig({ language: 'en' });
        }
        return;
      }

      if (config.language && config.language !== 'zh') {
        this.currentLanguage = config.language;
        await configService.updateConfig({ language_initialized: true });
        return;
      }

      try {
        const systemLocale = await window.electron.appInfo.getSystemLocale();
        const language = systemLocale === 'zh-CN' ? 'zh' : 'en';
        this.currentLanguage = language;
        await configService.updateConfig({
          language,
          language_initialized: true,
        });
      } catch (error) {
        console.error('Failed to get system locale:', error);
        this.currentLanguage = 'en';
        await configService.updateConfig({
          language: 'en',
          language_initialized: true,
        });
      }
    } catch (error) {
      console.error('Failed to initialize language:', error);
      this.currentLanguage = 'en';
    }
  }

  setLanguage(language: LanguageType, options: { persist?: boolean } = {}): void {
    const hasChanged = this.currentLanguage !== language;
    this.currentLanguage = language;

    if (hasChanged) {
      this.listeners.forEach(listener => listener());
    }

    if (options.persist === false) return;

    void configService
      .updateConfig({ language })
      .catch(error => console.error('Failed to save language setting:', error));
  }

  getLanguage(): LanguageType {
    return this.currentLanguage;
  }

  t(key: string): string {
    const translation = translations[this.currentLanguage][key];
    if (translation) return translation;

    console.warn(`Translation missing for key: ${key} in language: ${this.currentLanguage}`);
    return translations[this.currentLanguage === 'zh' ? 'en' : 'zh'][key] || key;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const i18nService = new I18nService();
