import { isRemotePath } from './format';

/** Normalize `remote://id` → `remote://id/` so roots and cwd share one form. */
export function normalizeRemotePath(path: string): string {
  if (!path.startsWith('remote://')) return path;
  const rest = path.slice('remote://'.length);
  if (!rest) return path;
  const slash = rest.indexOf('/');
  if (slash < 0) return `remote://${rest}/`;
  const conn = rest.slice(0, slash);
  const rel = rest.slice(slash + 1).replace(/\\/g, '/').replace(/\/+$/, '');
  return rel ? `remote://${conn}/${rel}` : `remote://${conn}/`;
}

/** Compare remote/local paths ignoring trailing slash differences. */
export function pathsEqual(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  if (a.startsWith('remote://') || b.startsWith('remote://')) {
    return normalizeRemotePath(a) === normalizeRemotePath(b);
  }
  const na = a.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const nb = b.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return na === nb;
}

/** Parent directory of `path`, or null if already at root. */
export function parentPath(path: string): string | null {
  if (!path) return null;
  if (isRemotePath(path) && path.startsWith('remote://')) {
    const normalized = normalizeRemotePath(path);
    const withoutScheme = normalized.slice('remote://'.length);
    const slash = withoutScheme.indexOf('/');
    const conn = slash >= 0 ? withoutScheme.slice(0, slash) : withoutScheme;
    const rel = slash >= 0 ? withoutScheme.slice(slash + 1).replace(/\/+$/, '') : '';
    if (!rel) return null;
    const idx = rel.lastIndexOf('/');
    if (idx < 0) return `remote://${conn}/`;
    return `remote://${conn}/${rel.slice(0, idx)}`;
  }
  const sep = path.includes('\\') ? '\\' : '/';
  const norm = path.replace(/\\/g, '/');
  if (norm.length <= 1) return null;
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return sep === '/' ? '/' : null;
  if (sep === '\\') {
    return path.slice(0, path.lastIndexOf('\\'));
  }
  return norm.slice(0, idx);
}

/** True if `child` is under `root` (same root or deeper). */
export function isPathUnderRoot(root: string, child: string): boolean {
  if (!root || !child) return false;
  if (root.startsWith('remote://') || child.startsWith('remote://')) {
    const r = normalizeRemotePath(root).replace(/\/+$/, '');
    const c = normalizeRemotePath(child).replace(/\/+$/, '');
    return c === r || c.startsWith(`${r}/`);
  }
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = child.replace(/\\/g, '/');
  return c === r || c.startsWith(`${r}/`);
}

export function looksLikeSystemPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  if (norm === '/' || norm === '/System' || norm.startsWith('/System/')) return true;
  if (norm === '/usr' || norm.startsWith('/usr/')) return true;
  if (norm === '/bin' || norm.startsWith('/bin/')) return true;
  if (/^\/System\/Library\/CoreServices/.test(norm)) return true;
  if (/^[A-Za-z]:\/Windows/i.test(norm.replace(/\\/g, '/'))) return true;
  if (/^[A-Za-z]:\\Windows/i.test(path)) return true;
  return false;
}
