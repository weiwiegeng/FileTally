export interface DiskInfo {
  name: string;
  mount_point: string;
  total_space: number;
  used_space: number;
  available_space: number;
  file_system: string;
  is_removable: boolean;
  disk_type: string;
  usage_percent: number;
}

export interface DiskOverview {
  disks: DiskInfo[];
  total_count: number;
  total_space: number;
  total_used: number;
  total_available: number;
}
