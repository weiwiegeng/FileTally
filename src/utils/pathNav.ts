import { isRemotePath } from './format';

/** Parent directory of `path`, or null if already at root. */
export function parentPath(path: string): string | null {
  if (!path) return null;
  if (isRemotePath(path) && path.startsWith('remote://')) {
    const withoutScheme = path.slice('remote://'.length);
    const slash = withoutScheme.indexOf('/');
    const conn = slash >= 0 ? withoutScheme.slice(0, slash) : withoutScheme;
    const rel = slash >= 0 ? withoutScheme.slice(slash + 1) : '';
    if (!rel) return null;
    const norm = rel.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    if (idx < 0) return `remote://${conn}`;
    return `remote://${conn}/${norm.slice(0, idx)}`;
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