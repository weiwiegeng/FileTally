mod app_prefs;
mod commands;
mod err;
mod job_runner;
mod models;
mod path_util;

use std::sync::Arc;

use app_prefs::{set_close_to_tray, AppPrefs};
use commands::{
    analyze_folder, apply_batch_ops, apply_organize, check_integrity_with_excel,
    list_material_presets, run_material_check,
    check_keywords, check_path_exists, check_transfer_conflicts,
    clear_diagnostics, compare_sync, connect_sftp, connect_smb, connect_system_smb, connect_webdav,
    cleanup_r2r_temp, delete_cleanup_items, delete_connection_password, delete_remote_paths,
    disconnect_remote, disconnect_smb, empty_trash, export_diagnostics, filter_files_by_rules,
    get_diagnostics, get_disks, get_file_preview, get_home_dir, get_path_info,
    get_transfer_bandwidth_limit, get_transfer_concurrency, index_root, index_root_incremental,
    list_folder_contents, list_path_tags, list_remote_dir, list_trash, list_volumes,
    load_connection_password, mkdir_path, path_space_info,
    preview_batch_ops, preview_organize, read_excel_info, refresh_disks, remote_path_exists,
    remote_path_info, remove_path_tag, rename_file, restore_trash_item, run_sync,
    save_connection_password, scan_cleanup_suggestions, scan_directory, scan_folder_tree,
    search_files, search_index, search_index_filename, set_path_tag, set_transfer_bandwidth_limit,
    set_transfer_concurrency, transfer_files, transfer_files_remote, trash_user_paths,
    undo_cleanup_delete, undo_organize, verify_duplicate_files, RemoteSessionStore,
};
use job_runner::{cancel_job, prepare_job};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(RemoteSessionStore::default()))
        .manage(Arc::new(AppPrefs::default()))
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "Show FileTally", true, None::<&str>)?;
            let tasks_i = MenuItem::with_id(app, "tasks", "Tasks", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &tasks_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("missing default window icon"),
                )
                .menu(&menu)
                .tooltip("FileTally")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        show_main_window(app);
                    }
                    "tasks" => {
                        show_main_window(app);
                        let _ = app.emit("tray-open-tasks", ());
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let prefs = window.state::<Arc<AppPrefs>>();
                if prefs.close_to_tray() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_disks,
            refresh_disks,
            scan_directory,
            get_file_preview,
            get_home_dir,
            search_files,
            check_keywords,
            prepare_job,
            cancel_job,
            check_path_exists,
            list_volumes,
            analyze_folder,
            scan_cleanup_suggestions,
            check_transfer_conflicts,
            transfer_files,
            set_transfer_bandwidth_limit,
            get_transfer_bandwidth_limit,
            set_transfer_concurrency,
            get_transfer_concurrency,
            get_path_info,
            list_folder_contents,
            read_excel_info,
            check_integrity_with_excel,
            list_material_presets,
            run_material_check,
            scan_folder_tree,
            rename_file,
            mkdir_path,
            path_space_info,
            set_close_to_tray,
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
            preview_organize,
            apply_organize,
            undo_organize,
            compare_sync,
            run_sync,
            index_root,
            index_root_incremental,
            search_index,
            search_index_filename,
            verify_duplicate_files,
            cleanup_r2r_temp,
            delete_cleanup_items,
            delete_remote_paths,
            trash_user_paths,
            undo_cleanup_delete,
            list_trash,
            restore_trash_item,
            empty_trash,
            preview_batch_ops,
            apply_batch_ops,
            set_path_tag,
            list_path_tags,
            remove_path_tag,
            connect_webdav,
            connect_sftp,
            disconnect_remote,
            get_diagnostics,
            clear_diagnostics,
            export_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
