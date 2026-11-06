import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN';
import enUS from './locales/en-US';

const SETTINGS_STORAGE_KEY = 'filetally-settings';

function readPersistedLanguage(): 'zh-CN' | 'en-US' | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { state?: { settings?: { language?: string } } };
    const lang = parsed.state?.settings?.language;
    if (lang === 'zh-CN' || lang === 'en-US') return lang;
  } catch {
    // ignore corrupt persisted settings
  }
  return undefined;
}

const initialLanguage = readPersistedLanguage() ?? 'zh-CN';

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    'en-US': { translation: enUS },
  },
  lng: initialLanguage,
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
