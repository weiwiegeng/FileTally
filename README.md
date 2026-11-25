# FileTally

日常 **本机 + NAS** 文件工作区：双栏浏览本地与 `remote://` 共享、连接管理、搜索、排队传输、轻量同步、整理与任务进度。基于 Tauri 2 + React，核心 IO 在 Rust。

[![License: LGPL-3.0](https://img.shields.io/badge/License-LGPL--3.0-blue.svg)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)

## 日常用起来做什么

| 模块 | 一句话 |
|------|--------|
| 文件浏览 | 双栏本地 ↔ NAS；Places（收藏/最近/连接）；空态可直接选本机或去添加连接 |
| 远程连接 | SMB / WebDAV / SFTP；钥匙串记密码；入口在「工作区」 |
| 智能搜索 | 本机可建 SQLite 索引；NAS 为全目录扫描 |
| 文件传输 | 本地 ↔ 远程、**远程↔远程（经本机临时目录）**、冲突策略、**持久化队列**；双栏复制/移动或「发送到传输页」；进度在**任务中心** |
| 同步 | 本机与 **`remote://`** 单向/双向；对比后执行；可定时（应用打开时） |
| 整理工具 | 规则筛选、批量整理（含 remote:// 根目录）、回收站 |
| 磁盘监控 | 本机分区容量与占用 |

**移动语义：** 本机同盘真移动；涉及远程时为「复制成功后再删源」。双栏开传后会打开任务抽屉。

大目录任务在后台跑，由统一 **JobRunner** 分配/取消；设置里可导出**诊断 JSON**（无密码）便于排错。

## 专业工具（可选）

| 模块 | 一句话 |
|------|--------|
| 智能检查 | Excel 名单 ↔ 目录核对（含远程） |
| 智能分析 | 空间统计、清理建议、可配置 AI 解读 |

侧栏「更多」中入口权重低于工作区 / 传输与同步。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2 |
| 前端 | React 19、TypeScript、Vite、Ant Design 6、Zustand、i18next |
| 后端 | Rust（`src-tauri/src/commands/*`）；远程协议 SMB / WebDAV / SFTP |

架构说明见 [docs/architecture.md](./docs/architecture.md)。

## 快速开始

**环境：** Node.js 18+、Rust 1.70+、npm

```bash
npm install
npm run tauri:dev
```

**检查：**

```bash
npx tsc --noEmit
npm test
CARGO_TARGET_DIR=target cargo test --manifest-path src-tauri/Cargo.toml --lib
```

**本地发布构建：**

```bash
npm run tauri:build
./build.sh windows   # 或 macos / all → release/
```

**GitHub 多平台安装包：** 日常 push / PR 只跑 [CI](.github/workflows/ci.yml)。打标签后 [Release](.github/workflows/release.yml) 构建并挂到 **Draft Release**：

| 系统 | 文件 |
|------|------|
| Windows | `*_x64-setup.exe` |
| macOS（Apple Silicon） | `*_aarch64.dmg` |
| Linux | `*_amd64.AppImage` |

```bash
git tag v1.0.0
git push origin v1.0.0
# 或在 Actions → Release → Run workflow
```

## 许可证

[LGPL-3.0](./LICENSE)。可商用；对本项目本身的修改随程序分发时需按 LGPL 开源相应改动。
