import { invoke } from '@tauri-apps/api/core';
import {
  TransferDirection,
  TransferItem,
  useRemoteStore,
  useTransferStore,
} from '../../stores';
import { mapBackendError } from '../../utils/backendError';
import { getPathName } from '../../utils/format';

const isAppRemotePath = (path: string) => path.startsWith('remote://');

const parseRemoteConnectionId = (path: string): string | null => {
  const m = path.match(/^remote:\/\/([^/]+)/);
  return m?.[1] ?? null;
};

const connectionNameForPath = (path: string): string | undefined => {
  const id = parseRemoteConnectionId(path);
  if (!id) return undefined;
  return useRemoteStore.getState().getConnection(id)?.name;
};

const formatSize = (size: number): string => {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (size >= GB) return `${(size / GB).toFixed(2)} GB`;
  if (size >= MB) return `${(size / MB).toFixed(2)} MB`;
  if (size >= KB) return `${(size / KB).toFixed(2)} KB`;
  return `${size} B`;
};

export async function buildTransferItems(paths: string[]): Promise<TransferItem[]> {
  const items: TransferItem[] = [];
  for (const path of paths) {
    try {
      const info = await invoke<{
        size: number;
        sizeFormatted: string;
        isDir: boolean;
        name: string;
      }>('get_path_info', { path });
      items.push({
        id: '',
        sourcePath: path,
        fileName: info.name,
        fileType: info.isDir ? 'folder' : 'file',
        size: info.size,
        sizeFormatted: info.sizeFormatted || formatSize(info.size),
      });
    } catch (err) {
      items.push({
        id: '',
        sourcePath: path,
        fileName: getPathName(path) || path,
        fileType: 'file',
        size: 0,
        sizeFormatted: formatSize(0),
      });
      console.warn(mapBackendError(err));
    }
  }
  return items;
}

export function resolveTransferSetup(
  sourcePaths: string[],
  targetPath: string
): {
  direction: TransferDirection;
  sourceConnectionName?: string;
  targetConnectionName?: string;
} {
  const sourceRemote = sourcePaths.some(isAppRemotePath);
  const targetRemote = isAppRemotePath(targetPath);
  let direction: TransferDirection = 'upload';
  if (sourceRemote && !targetRemote) direction = 'download';
  else if (!sourceRemote && targetRemote) direction = 'upload';
  else if (sourceRemote && targetRemote) direction = 'upload';

  const sourceConnectionName = sourceRemote
    ? connectionNameForPath(sourcePaths.find(isAppRemotePath) || '')
    : undefined;
  const targetConnectionName = targetRemote
    ? connectionNameForPath(targetPath)
    : undefined;

  return { direction, sourceConnectionName, targetConnectionName };
}

export async function runCopyToTarget(
  sourcePaths: string[],
  targetPath: string
): Promise<'conflicts' | 'none' | 'error'> {
  const store = useTransferStore.getState();
  const items = await buildTransferItems(sourcePaths);
  if (!items.length) return 'error';

  const setup = resolveTransferSetup(sourcePaths, targetPath);
  store.setDirection(setup.direction);
  store.clearSourceItems();
  store.addSourceItems(items, setup.sourceConnectionName);
  store.setTargetPath(targetPath, setup.targetConnectionName);

  return store.checkConflicts();
}

export function pathsEligibleForLocalMove(
  sourcePaths: string[],
  targetPath: string
): boolean {
  if (!targetPath) return false;
  return (
    sourcePaths.length > 0 &&
    sourcePaths.every((p) => !isAppRemotePath(p)) &&
    !isAppRemotePath(targetPath)
  );
}