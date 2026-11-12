import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ar from './ar';
import en from './en';

export const LANGS = [
  { code: 'ar', label: 'العربية', dir: 'rtl' },
  { code: 'en', label: 'English', dir: 'ltr' },
] as const;

const stored = (() => {
  try {
    return localStorage.getItem('ep.lang');
  } catch {
    return null;
  }
})();

i18n.use(initReactI18next).init({
  resources: { ar: { translation: ar }, en: { translation: en } },
  lng: stored === 'en' ? 'en' : 'ar',
  // Arabic is the complete reference language; any key missing in English falls back to it.
  fallbackLng: 'ar',
  interpolation: { escapeValue: false },
  returnNull: false,
});

const applyDir = (lng: string) => {
  const dir = LANGS.find((l) => l.code === lng)?.dir ?? 'rtl';
  document.documentElement.lang = lng;
  document.documentElement.dir = dir;
};
applyDir(i18n.language);
i18n.on('languageChanged', (lng) => {
  applyDir(lng);
  try {
    localStorage.setItem('ep.lang', lng);
  } catch {
    /* storage unavailable */
  }
});

export default i18n;
