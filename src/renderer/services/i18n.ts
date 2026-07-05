import { configService } from './config';
import { translations } from './i18n/translations';

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
          configService.updateConfig({ ...config, language: 'en' });
        }
        return;
      }

      if (config.language && config.language !== 'zh') {
        this.currentLanguage = config.language;
        configService.updateConfig({ ...config, language_initialized: true });
        return;
      }

      try {
        const systemLocale = await window.electron.appInfo.getSystemLocale();
        const language = systemLocale === 'zh-CN' ? 'zh' : 'en';
        this.currentLanguage = language;
        configService.updateConfig({
          ...config,
          language,
          language_initialized: true,
        });
      } catch (error) {
        console.error('Failed to get system locale:', error);
        this.currentLanguage = 'en';
        configService.updateConfig({
          ...config,
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

    try {
      const config = configService.getConfig();
      configService.updateConfig({ ...config, language });
    } catch (error) {
      console.error('Failed to save language setting:', error);
    }
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
