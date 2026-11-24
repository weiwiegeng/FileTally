mod commands;
mod err;
mod models;
mod path_util;

use std::sync::Arc;

use commands::{
    analyze_folder, apply_organize, cancel_analysis, cancel_excel_check, cancel_rule_filter,
    cancel_search, cancel_sync, cancel_transfer, check_folder_integrity, check_integrity_with_excel,
    check_keywords, check_path_exists, check_transfer_conflicts, compare_sync, connect_sftp,
    connect_smb, connect_system_smb, connect_webdav, delete_connection_password,
    disconnect_remote, disconnect_smb, filter_files_by_rules, get_disks, get_file_preview,
    get_home_dir, get_path_info, index_root, list_folder_contents, list_remote_dir, list_volumes,
    load_connection_password, match_excel_with_folder, prepare_analysis, prepare_excel_check,
    prepare_rule_filter, prepare_search, prepare_sync, prepare_transfer, preview_organize,
    read_excel_info, refresh_disks, remote_path_exists, remote_path_info, rename_file, run_sync,
    save_connection_password, scan_cleanup_suggestions, scan_directory, scan_folder_tree,
    search_files, search_index, set_transfer_bandwidth_limit, transfer_files,
    transfer_files_remote, undo_organize, RemoteSessionStore,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(RemoteSessionStore::default()))
        .invoke_handler(tauri::generate_handler![
            get_disks,
            refresh_disks,
            scan_directory,
            get_file_preview,
            get_home_dir,
            search_files,
            check_keywords,
            prepare_search,
            cancel_search,
            prepare_excel_check,
            cancel_excel_check,
            check_path_exists,
            list_volumes,
            analyze_folder,
            prepare_analysis,
            cancel_analysis,
            scan_cleanup_suggestions,
            check_transfer_conflicts,
            transfer_files,
            prepare_transfer,
            cancel_transfer,
            set_transfer_bandwidth_limit,
            get_path_info,
            list_folder_contents,
            read_excel_info,
            match_excel_with_folder,
            check_folder_integrity,
            check_integrity_with_excel,
            scan_folder_tree,
            rename_file,
            connect_system_smb,
            connect_smb,
            disconnect_smb,
            list_remote_dir,
            remote_path_exists,
            remote_path_info,
            transfer_files_remote,
            save_connection_password,
            load_connection_password,
            delete_connection_password,
            filter_files_by_rules,
            prepare_rule_filter,
            cancel_rule_filter,
            preview_organize,
            apply_organize,
            undo_organize,
            compare_sync,
            run_sync,
            prepare_sync,
            cancel_sync,
            index_root,
            search_index,
            connect_webdav,
            connect_sftp,
            disconnect_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
