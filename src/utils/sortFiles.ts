import { FileNode, SortField, SortOrder } from '../types';

/** 自然排序比较（数字按数值） */
export const naturalCompare = (a: string, b: string): number => {
  const aChars = a.toLowerCase().split('');
  const bChars = b.toLowerCase().split('');
  let i = 0;
  let j = 0;

  while (i < aChars.length && j < bChars.length) {
    const aIsDigit = /\d/.test(aChars[i]);
    const bIsDigit = /\d/.test(bChars[j]);

    if (aIsDigit && bIsDigit) {
      let aNum = 0;
      let bNum = 0;
      while (i < aChars.length && /\d/.test(aChars[i])) {
        aNum = aNum * 10 + parseInt(aChars[i], 10);
        i++;
      }
      while (j < bChars.length && /\d/.test(bChars[j])) {
        bNum = bNum * 10 + parseInt(bChars[j], 10);
        j++;
      }
      if (aNum !== bNum) return aNum - bNum;
    } else {
      if (aChars[i] !== bChars[j]) {
        return aChars[i].localeCompare(bChars[j], 'zh-CN');
      }
      i++;
      j++;
    }
  }
  return aChars.length - bChars.length;
};

export const compareFileNodes = (
  a: FileNode,
  b: FileNode,
  sortField: SortField,
  sortOrder: SortOrder
): number => {
  let compare = 0;
  switch (sortField) {
    case 'name':
      compare = naturalCompare(a.name, b.name);
      break;
    case 'size':
      compare = a.size - b.size;
      break;
    case 'modified_time':
      compare = a.modified_time - b.modified_time;
      break;
    case 'extension':
      compare = (a.extension || '').localeCompare(b.extension || '', 'zh-CN');
      break;
    default:
      compare = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
  }
  return sortOrder === 'asc' ? compare : -compare;
};

/** 文件夹在前，再按字段排序 */
export const sortFileNodes = (
  nodes: FileNode[],
  sortField: SortField,
  sortOrder: SortOrder
): FileNode[] => {
  const folders = nodes.filter((n) => n.is_dir).sort((a, b) => compareFileNodes(a, b, sortField, sortOrder));
  const files = nodes.filter((n) => !n.is_dir).sort((a, b) => compareFileNodes(a, b, sortField, sortOrder));
  return [...folders, ...files];
};

/** 设置里的 sortBy 兼容旧值 date/type */
export const normalizeSortField = (value: string): SortField => {
  if (value === 'date') return 'modified_time';
  if (value === 'type') return 'extension';
  if (value === 'name' || value === 'size' || value === 'modified_time' || value === 'extension') {
    return value;
  }
  return 'name';
};
