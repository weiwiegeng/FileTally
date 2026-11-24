/**
 * Format bytes to human readable string
 */
export function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  const TB = GB * 1024;

  if (bytes >= TB) {
    return `${(bytes / TB).toFixed(2)} TB`;
  } else if (bytes >= GB) {
    return `${(bytes / GB).toFixed(2)} GB`;
  } else if (bytes >= MB) {
    return `${(bytes / MB).toFixed(2)} MB`;
  } else if (bytes >= KB) {
    return `${(bytes / KB).toFixed(2)} KB`;
  } else {
    return `${bytes} B`;
  }
}

/**
 * Format timestamp to date string
 */
export function formatDate(timestamp: number): string {
  if (!timestamp) return '-';
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Get file type category from extension
 */
export function getFileCategory(extension: string): string {
  const ext = extension.toLowerCase();
  
  const categories: Record<string, string[]> = {
    image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'],
    document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'],
    text: ['txt', 'md', 'rtf', 'csv'],
    code: ['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'html', 'css', 'scss', 'json', 'xml', 'yaml', 'yml', 'toml'],
    video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'flv'],
    audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
  };

  for (const [category, extensions] of Object.entries(categories)) {
    if (extensions.includes(ext)) {
      return category;
    }
  }
  return 'other';
}

/**
 * Cross-platform path utilities
 */

/**
 * Detect if current platform is Windows based on path format
 */
export function isWindowsPath(path: string): boolean {
  // Windows paths: C:\, D:\, \\server\share, etc.
  return /^[A-Za-z]:\\|^\\\\/.test(path);
}

/**
 * Get path separator based on path format
 */
export function getPathSeparator(path: string): string {
  return isWindowsPath(path) ? '\\' : '/';
}

/**
 * Split path into parts (cross-platform)
 */
export function splitPath(path: string): string[] {
  if (!path) return [];
  // Normalize to forward slashes, then split
  return path.replace(/\\/g, '/').split('/').filter(Boolean);
}

/**
 * Get file/folder name from path (cross-platform)
 */
export function getPathName(path: string): string {
  if (!path) return '';
  const parts = splitPath(path);
  return parts[parts.length - 1] || '';
}

/**
 * Check if path is a remote/network path
 * - macOS: /Volumes/xxx
 * - Windows: \\server\share or mapped drive like Z:\
 */
export function isRemotePath(path: string): boolean {
  if (!path) return false;
  // In-app direct SMB
  if (path.startsWith('remote://')) return true;
  // macOS mounted volumes
  if (path.startsWith('/Volumes/')) return true;
  // Windows UNC paths
  if (path.startsWith('\\\\')) return true;
  // Could add more heuristics for Windows mapped drives
  return false;
}

/**
 * Get the mount point or root from a path
 * - macOS: /Volumes/ShareName -> /Volumes/ShareName
 * - Windows: \\server\share -> \\server\share, C:\ -> C:\
 */
export function getMountPoint(path: string): string {
  if (!path) return '';
  
  // macOS /Volumes/xxx
  const volumeMatch = path.match(/^\/Volumes\/[^\/]+/);
  if (volumeMatch) return volumeMatch[0];
  
  // Windows UNC \\server\share
  const uncMatch = path.match(/^\\\\[^\\]+\\[^\\]+/);
  if (uncMatch) return uncMatch[0];
  
  // Windows drive C:\
  const driveMatch = path.match(/^[A-Za-z]:\\/);
  if (driveMatch) return driveMatch[0];
  
  // Unix root
  if (path.startsWith('/')) return '/';
  
  return '';
}
