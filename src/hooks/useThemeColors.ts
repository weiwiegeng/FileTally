import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../stores';

export interface ThemeColors {
  // 背景色
  bgPrimary: string;
  bgSecondary: string;
  bgCard: string;
  bgCardGradient: string;
  bgHover: string;
  
  // 边框
  border: string;
  borderLight: string;
  
  // 文字
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  
  // 强调色
  accentBlue: string;
  accentGreen: string;
  accentOrange: string;
  accentPurple: string;
  accentRed: string;
  
  // 其他
  isDark: boolean;
}

const getSystemPrefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

export const useThemeColors = (): ThemeColors => {
  const { settings } = useSettingsStore();
  const [systemDark, setSystemDark] = useState(getSystemPrefersDark);

  useEffect(() => {
    if (settings.theme !== 'system' || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [settings.theme]);
  
  return useMemo(() => {
    const isDark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && systemDark);
    
    if (isDark) {
      return {
        bgPrimary: '#0f0f1a',
        bgSecondary: '#1a1a2e',
        bgCard: '#16213e',
        bgCardGradient: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        bgHover: 'rgba(24, 144, 255, 0.1)',
        border: '#303050',
        borderLight: 'rgba(255, 255, 255, 0.1)',
        textPrimary: '#ffffff',
        textSecondary: '#8c8c8c',
        textMuted: '#595959',
        accentBlue: '#1890ff',
        accentGreen: '#52c41a',
        accentOrange: '#faad14',
        accentPurple: '#722ed1',
        accentRed: '#ff4d4f',
        isDark: true,
      };
    }
    
    // 浅色主题
    return {
      bgPrimary: '#ffffff',
      bgSecondary: '#f5f5f5',
      bgCard: '#ffffff',
      bgCardGradient: 'linear-gradient(135deg, #f0f2f5 0%, #e6e8eb 100%)',
      bgHover: 'rgba(24, 144, 255, 0.05)',
      border: '#d9d9d9',
      borderLight: 'rgba(0, 0, 0, 0.06)',
      textPrimary: '#000000',
      textSecondary: '#595959',
      textMuted: '#8c8c8c',
      accentBlue: '#1890ff',
      accentGreen: '#52c41a',
      accentOrange: '#fa8c16',
      accentPurple: '#722ed1',
      accentRed: '#ff4d4f',
      isDark: false,
    };
  }, [settings.theme, systemDark]);
};
