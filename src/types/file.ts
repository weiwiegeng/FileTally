export interface FileNode {
  id: string;
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_time: number;
  created_time: number;
  extension: string;
  children: FileNode[] | null;
  is_loaded: boolean;
  children_count: number | null;
  is_hidden: boolean;
}

export interface DirectoryScanResult {
  root_path: string;
  nodes: FileNode[];
  total_files: number;
  total_dirs: number;
  total_size: number;
}

export interface FileMetadata {
  name: string;
  path: string;
  size: number;
  size_formatted: string;
  modified_time: string;
  created_time: string;
  extension: string;
  mime_type: string;
}

export interface FilePreviewInfo {
  preview_type: 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'unsupported';
  content: string | null;
  metadata: FileMetadata;
}

export type SortField = 'name' | 'size' | 'modified_time' | 'extension';
export type SortOrder = 'asc' | 'desc';
export type ViewMode = 'tree' | 'list' | 'grid';
