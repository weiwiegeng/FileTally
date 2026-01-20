# FileTally 技术架构文档

## 一、项目概述

FileTally 是一款智能文件管理与分析系统，提供本地磁盘监控、文件浏览、远程存储连接、规则筛选及 AI 内容分析功能。

## 二、技术栈选型

### 2.1 核心框架

| 技术 | 版本 | 用途 |
|------|------|------|
| Tauri | 2.0 | 桌面应用框架，轻量高性能 |
| React | 18.x | 前端 UI 框架 |
| TypeScript | 5.x | 类型安全的前端开发 |
| Rust | 1.75+ | 后端核心逻辑 |

### 2.2 前端技术栈

| 技术 | 用途 |
|------|------|
| Vite | 构建工具，快速热更新 |
| Ant Design 5 | UI 组件库，科技感设计 |
| Zustand | 轻量级状态管理 |
| TanStack Query | 异步数据管理 |
| react-window | 虚拟滚动，大数据量渲染 |

### 2.3 Rust 依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| tauri | 2.0 | 桌面应用框架 |
| sysinfo | 0.32 | 系统磁盘信息获取 |
| walkdir | 2.5 | 递归目录遍历 |
| notify | 7.0 | 文件系统监听 |
| rayon | 1.10 | 并行计算 |
| pavao | 0.2 | SMB/CIFS 协议 |
| ssh2 | 0.9 | SFTP 协议 |
| reqwest | 0.12 | WebDAV HTTP 请求 |
| pdf-extract | 0.7 | PDF 文本提取 |
| async-openai | 0.27 | OpenAI API 集成 |
| rusqlite | 0.32 | 本地数据存储 |
| serde | 1.0 | 序列化/反序列化 |
| tokio | 1.0 | 异步运行时 |

## 三、系统架构

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                          前端表现层 (React)                          │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │  磁盘监控   │ │  文件浏览   │ │  远程连接   │ │  规则筛选/AI分析  │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                               │ Tauri IPC
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Rust 服务层                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  DiskService    │  │  FileService    │  │  RemoteService      │  │
│  │  磁盘信息服务    │  │  文件系统服务    │  │  远程存储服务        │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  FilterService  │  │  PreviewService │  │  AIService          │  │
│  │  规则筛选服务    │  │  文件预览服务    │  │  AI分析服务          │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          数据持久层                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │  SQLite         │  │  文件索引缓存    │  │  配置存储            │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 模块职责

| 模块 | 职责 |
|------|------|
| DiskService | 获取系统所有磁盘信息、空间统计 |
| FileService | 本地文件遍历、目录树构建、文件操作 |
| RemoteService | SMB/WebDAV/SFTP 远程连接管理 |
| FilterService | 规则解析与执行、文件筛选 |
| PreviewService | 文件内容预览、格式转换 |
| AIService | PDF 文本提取、LLM 内容分析 |

## 四、数据流设计

### 4.1 文件浏览流程

```
用户选择目录 → FileService.scan_directory()
     │
     ├─ 返回第一层子项（懒加载）
     │
     └─ 用户展开节点 → 加载该节点子项
           │
           └─ 用户点击文件 → PreviewService.get_preview()
```

### 4.2 远程连接流程

```
用户配置连接 → RemoteService.test_connection()
     │
     ├─ 成功 → 保存配置（加密凭据）
     │
     └─ RemoteService.browse() → 返回远程目录结构
```

### 4.3 AI 分析流程

```
用户选择 PDF → PreviewService.extract_pdf_text()
     │
     └─ 用户输入提示词 → AIService.analyze()
           │
           └─ 返回分析结果（是否包含、位置、摘要）
```

## 五、前端组件架构

```
src/
├── components/
│   ├── layout/
│   │   ├── Sidebar.tsx          # 侧边栏导航
│   │   ├── Header.tsx           # 顶部栏
│   │   └── MainLayout.tsx       # 主布局
│   │
│   ├── disk/
│   │   ├── DiskOverview.tsx     # 磁盘概览面板
│   │   ├── DiskCard.tsx         # 单个磁盘卡片
│   │   └── SpaceChart.tsx       # 空间占用图表
│   │
│   ├── browser/
│   │   ├── FileTree.tsx         # 文件树（虚拟滚动）
│   │   ├── FileList.tsx         # 文件列表视图
│   │   ├── FilePreview.tsx      # 文件预览面板
│   │   ├── Breadcrumb.tsx       # 面包屑导航
│   │   └── FileIcon.tsx         # 文件类型图标
│   │
│   ├── remote/
│   │   ├── ConnectionManager.tsx # 连接管理
│   │   ├── ConnectionForm.tsx    # 连接配置表单
│   │   └── RemoteBrowser.tsx     # 远程文件浏览
│   │
│   ├── filter/
│   │   ├── RuleBuilder.tsx      # 规则构建器
│   │   ├── RuleItem.tsx         # 单条规则
│   │   └── FilterResults.tsx    # 筛选结果
│   │
│   └── ai/
│       ├── PdfAnalyzer.tsx      # PDF分析器
│       ├── PromptInput.tsx      # 提示词输入
│       └── AnalysisResult.tsx   # 分析结果展示
│
├── hooks/
│   ├── useDisk.ts               # 磁盘信息 Hook
│   ├── useFileTree.ts           # 文件树 Hook
│   ├── useRemote.ts             # 远程连接 Hook
│   └── useAI.ts                 # AI分析 Hook
│
├── services/
│   ├── tauri.ts                 # Tauri IPC 封装
│   ├── disk.ts                  # 磁盘服务调用
│   ├── file.ts                  # 文件服务调用
│   ├── remote.ts                # 远程服务调用
│   └── ai.ts                    # AI服务调用
│
├── stores/
│   ├── appStore.ts              # 全局应用状态
│   ├── fileStore.ts             # 文件浏览状态
│   └── filterStore.ts           # 筛选规则状态
│
├── types/
│   ├── disk.ts                  # 磁盘相关类型
│   ├── file.ts                  # 文件相关类型
│   ├── remote.ts                # 远程连接类型
│   └── filter.ts                # 筛选规则类型
│
└── utils/
    ├── format.ts                # 格式化工具
    ├── fileType.ts              # 文件类型判断
    └── crypto.ts                # 加密工具
```

## 六、Rust 模块结构

```
src-tauri/
├── src/
│   ├── main.rs                  # 入口文件
│   ├── lib.rs                   # 库导出
│   │
│   ├── commands/                # Tauri 命令
│   │   ├── mod.rs
│   │   ├── disk.rs              # 磁盘相关命令
│   │   ├── file.rs              # 文件相关命令
│   │   ├── remote.rs            # 远程连接命令
│   │   ├── filter.rs            # 筛选相关命令
│   │   └── ai.rs                # AI分析命令
│   │
│   ├── services/                # 业务服务
│   │   ├── mod.rs
│   │   ├── disk_service.rs      # 磁盘服务
│   │   ├── file_service.rs      # 文件服务
│   │   ├── remote_service.rs    # 远程存储服务
│   │   ├── filter_service.rs    # 筛选服务
│   │   ├── preview_service.rs   # 预览服务
│   │   └── ai_service.rs        # AI服务
│   │
│   ├── models/                  # 数据模型
│   │   ├── mod.rs
│   │   ├── disk.rs
│   │   ├── file.rs
│   │   ├── remote.rs
│   │   └── filter.rs
│   │
│   ├── storage/                 # 数据存储
│   │   ├── mod.rs
│   │   ├── database.rs          # SQLite 操作
│   │   └── cache.rs             # 缓存管理
│   │
│   └── utils/                   # 工具函数
│       ├── mod.rs
│       ├── crypto.rs            # 加密解密
│       └── format.rs            # 格式转换
│
├── Cargo.toml
└── tauri.conf.json
```

## 七、性能优化策略

### 7.1 大量文件处理

| 策略 | 实现方式 |
|------|----------|
| 懒加载 | 只加载当前展开的目录层级 |
| 虚拟滚动 | react-window 实现可视区域渲染 |
| 分页加载 | 单目录超过 1000 项时分页 |
| 并行遍历 | Rust rayon 并行扫描 |
| 增量索引 | SQLite 存储已扫描目录信息 |

### 7.2 内存优化

| 策略 | 说明 |
|------|------|
| 流式处理 | 大文件预览采用流式读取 |
| LRU 缓存 | 文件预览内容使用 LRU 缓存 |
| 及时释放 | 切换目录时释放非可见数据 |

### 7.3 网络优化

| 策略 | 说明 |
|------|------|
| 连接池 | 远程连接复用 |
| 请求合并 | 批量获取文件信息 |
| 断点续传 | 大文件传输支持断点 |

## 八、安全设计

| 安全项 | 实现方式 |
|--------|----------|
| 凭据存储 | 使用系统密钥链加密存储 |
| 传输加密 | 远程连接使用 SSL/TLS |
| 权限控制 | 磁盘访问权限系统授权检测 |
| 输入校验 | 所有用户输入进行校验 |

## 九、跨平台支持

| 平台 | 支持状态 |
|------|----------|
| macOS | 完全支持 |
| Windows | 完全支持 |
| Linux | 完全支持 |
