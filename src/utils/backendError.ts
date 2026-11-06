import i18n from '../i18n';

/** Parse `FTERR:code` / `FTERR:code|detail` and map to localized text. */
export function mapBackendError(err: unknown): string {
  const raw = typeof err === 'string' ? err : String(err ?? '');
  const cleaned = raw.replace(/^error:\s*/i, '').trim();

  const match = cleaned.match(/^FTERR:([a-z0-9_]+)(?:\|([\s\S]*))?$/i);
  if (match) {
    const code = match[1];
    const detail = match[2]?.trim();
    const key = `errors.${code}`;
    if (i18n.exists(key)) {
      const base = i18n.t(key);
      return detail ? `${base}: ${detail}` : base;
    }
    return detail ? `${code}: ${detail}` : code;
  }

  // Fallback: strip known Chinese leftovers from older builds
  const legacy: Array<[RegExp, string]> = [
    [/^路径不能为空$/, 'path_empty'],
    [/^路径包含非法字符$/, 'path_illegal_char'],
    [/^相对路径不能包含 \.\.$/, 'path_relative_parent'],
    [/^名称不能为空$/, 'name_empty'],
    [/^名称不能为 \. 或 \.\.$/, 'name_dot_forbidden'],
    [/^名称包含非法字符$/, 'name_illegal_char'],
  ];
  for (const [re, code] of legacy) {
    if (re.test(cleaned)) {
      const key = `errors.${code}`;
      if (i18n.exists(key)) return i18n.t(key);
    }
  }

  return cleaned || i18n.t('errors.unknown');
}
