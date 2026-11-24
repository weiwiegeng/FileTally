# FileTally - 智能文件管理器

一款基于 Tauri 2.0 构建的跨平台智能文件管理工具，提供文件浏览、预览、分析、搜索及远程 NAS 传输等功能。

## 功能特性

### 文件浏览
- 树形目录导航
- 支持本地和远程 (SMB/NAS) 文件系统
- 文件/文件夹详细信息展示

### 文件预览
- PDF 文档预览
- Excel 表格预览
- Word 文档预览
- 图片预览（JPG、PNG、GIF 等）
- 音视频播放
- 文本/代码文件预览

### 智能搜索
- 关键词搜索
- 支持路径匹配和文件名匹配
- 远程文件夹搜索
- 搜索结果导出 Excel

### 文件夹分析
- 文件类型统计
- 空间占用分析
- AI 文档助手
- 清理建议

### 文件传输
- 本地 ↔ NAS 双向传输
- 文件夹批量上传/下载
- 文件名冲突处理（覆盖/跳过/重命名）
- 传输进度显示

### 其他
- 磁盘空间监控
- 深色/浅色主题切换
- 中英文多语言支持

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | Tauri 2.0 |
| 前端 | React 19 + TypeScript |
| UI 组件 | Ant Design 6 |
| 状态管理 | Zustand |
| 后端 | Rust |
| 国际化 | i18next |

## 开发环境

### 前置要求
- Node.js 18+
- Rust 1.70+
- pnpm / npm

### 安装依赖
```bash
npm install
```

### 开发模式
```bash
npm run tauri dev
```

### 构建应用
```bash
# macOS
npm run tauri build

# Windows (交叉编译)
npm run tauri build -- --target x86_64-pc-windows-gnu
```

## 项目结构

```
FileTally/
├── src/                    # 前端源码
│   ├── components/         # React 组件
│   │   ├── analysis/       # 文件夹分析
│   │   ├── browser/        # 文件浏览器
│   │   ├── disk/           # 磁盘监控
│   │   ├── preview/        # 文件预览
│   │   ├── remote/         # 远程连接
│   │   ├── search/         # 智能搜索
│   │   ├── settings/       # 设置
│   │   └── transfer/       # 文件传输
│   ├── stores/             # Zustand 状态
│   ├── services/           # 服务层
│   ├── i18n/               # 国际化配置
│   └── utils/              # 工具函数
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── commands/       # Tauri 命令
│   │   └── lib.rs          # 入口文件
│   └── Cargo.toml
└── package.json
```

## 安装包

| 平台 | 文件 |
|------|------|
| Windows | `FileTally_x.x.x_x64-setup.exe` |
| macOS (Apple Silicon) | `FileTally_x.x.x_aarch64.dmg` |
| macOS (Intel) | `FileTally_x.x.x_x64.dmg` |

## 推荐 IDE

- [VS Code](https://code.visualstudio.com/)
  - [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  - [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## License

[LGPL-3.0](./LICENSE)
