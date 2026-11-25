# FileTally 技术架构

## 概述

FileTally 是 **Tauri 2 + React 19** 桌面应用，面向本机与 NAS 的日常文件工作区：浏览、搜索、传输、整理与任务进度。业务逻辑主要在 **Rust `#[tauri::command]`** 中实现；前端通过 `invoke` 调用，用 **Zustand** 管理 UI 与客户端状态。

`@tanstack/react-query` 已在依赖中但当前未使用；数据拉取以 `invoke` + store 事件为主。

## 目录结构（摘要）

```
src/                    React UI、Zustand stores、i18n
  components/           按功能分屏（browser、search、transfer…）
  stores/               zustand（settings、transfer、search、tasks…）
  utils/                纯函数（backendError、transferQueue…）

src-tauri/src/
  lib.rs                Tauri 入口与 invoke 注册
  commands/             按域划分的 command 模块
    disk.rs file.rs search.rs transfer.rs remote.rs …
    batch_ops.rs cleanup_ops.rs diag.rs …
  path_util.rs          路径校验、remote:// 虚拟路径
  models.rs err.rs      共享类型与错误码
```

## 前后端边界

| 层 | 职责 |
|----|------|
| React | 布局、表单、列表/树、任务中心 UI、localStorage 持久化（设置、传输队列等） |
| Tauri IPC | 类型安全的 `invoke('command_name', payload)` |
| Rust commands | 磁盘/文件 IO、SMB·WebDAV·SFTP、扫描、传输、索引（SQLite）、诊断环缓冲 |

远程路径统一为 `remote://{connectionId}/relative/path`，由 `path_util` 解析；会话状态在 `RemoteSessionStore`（`Arc` + `manage`）。

## 状态管理（前端）

- **settingsStore**：主题、语言、搜索默认值、双栏浏览、传输并发等（persist）
- **transferStore**：源/目标、冲突、进度；**传输队列**序列化到 localStorage（`utils/transferQueue.ts`）
- **dualPaneStore / navigationStore**：双栏根目录与跨页导航（浏览器 → 传输）
- **taskStore**：与后端 job id 对齐的可取消任务
- **syncPresetsStore**：轻量同步方案本地保存

无单独的 “Service 层” TypeScript 包；除 AI 配置（`services/aiProviders`）外，文件操作一律走 Rust。

## 后端模块（commands）

| 模块 | 能力 |
|------|------|
| `disk` | 分区与容量 |
| `file` | 列表、预览、重命名 |
| `search` / `tools::index` | 内容搜索、SQLite 文件名索引 |
| `transfer` + `remote` | 本地↔远程传输、冲突策略、限速 |
| `batch_ops` | 浏览器批量复制/移动 |
| `cleanup_ops` | 回收站、清理建议删除 |
| `duplicate` / `analysis` | 重复与空间分析 |
| `excel_*` | Excel 核对（可选远程） |
| `credentials` | 钥匙串存密码（不进诊断导出） |
| `diag` | 内存环缓冲诊断事件 |

## 事件与进度

长任务通过 Tauri `emit`（如 `transfer-progress`、`search-progress`）推送到前端；`TaskBridge` 监听并写入 `taskStore`。

## 数据持久化

| 数据 | 位置 |
|------|------|
| 文件名索引 | 应用数据目录 SQLite（`rusqlite` bundled） |
| 回收站清单 | 应用数据目录 JSON + 影子文件树 |
| 连接密码 | 系统钥匙串（keyring） |
| 用户设置 / 传输队列 | 前端 localStorage |

## 诊断（Phase 5）

`diag.rs` 保留最近约 200 条 `{ ts, level, code, message, job_id }`；`export_diagnostics` 输出 JSON（含 `app_version`，**不含密码**）。传输 prepare/cancel/本地同步结束会轻量写入。

## 构建与 CI

- 前端：`vite` + `tsc`；单元测试 `vitest`（`src/**/*.test.ts`）
- 后端：`cargo test --manifest-path src-tauri/Cargo.toml --lib`
- GitHub Actions：`.github/workflows/ci.yml`