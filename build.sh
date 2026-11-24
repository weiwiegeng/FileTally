#!/bin/bash

# FileTally 跨平台构建脚本
# 用法: ./build.sh [windows|macos|all]

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="$PROJECT_DIR/release"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  FileTally 构建脚本${NC}"
echo -e "${GREEN}========================================${NC}"

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 检查依赖
check_dependencies() {
    echo -e "\n${YELLOW}检查依赖...${NC}"
    
    # 检查 Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}错误: 未找到 Node.js，请先安装${NC}"
        exit 1
    fi
    echo "  Node.js: $(node -v)"
    
    # 检查 Rust
    if ! command -v rustc &> /dev/null; then
        echo -e "${RED}错误: 未找到 Rust，请先安装${NC}"
        exit 1
    fi
    echo "  Rust: $(rustc --version)"
    
    # 检查 npm
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}错误: 未找到 npm，请先安装${NC}"
        exit 1
    fi
    echo "  npm: $(npm -v)"
}

# 构建 macOS 版本
build_macos() {
    echo -e "\n${GREEN}========================================${NC}"
    echo -e "${GREEN}  构建 macOS 版本${NC}"
    echo -e "${GREEN}========================================${NC}"
    
    cd "$PROJECT_DIR"
    
    echo -e "\n${YELLOW}开始构建...${NC}"
    npm run tauri build || true
    
    # 复制产物到输出目录
    echo -e "\n${YELLOW}复制安装包到输出目录...${NC}"
    
    APP_PATH="$PROJECT_DIR/src-tauri/target/release/bundle/macos/FileTally.app"
    DMG_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/dmg"
    
    if [ -d "$APP_PATH" ]; then
        rm -rf "$OUTPUT_DIR/FileTally.app"
        cp -R "$APP_PATH" "$OUTPUT_DIR/"
        echo -e "${GREEN}  ✓ FileTally.app${NC}"
    fi
    
    if ls "$DMG_DIR"/*.dmg 1> /dev/null 2>&1; then
        cp "$DMG_DIR"/*.dmg "$OUTPUT_DIR/"
        echo -e "${GREEN}  ✓ $(ls -1 "$DMG_DIR"/*.dmg | xargs -n1 basename)${NC}"
    fi
    
    echo -e "\n${GREEN}macOS 构建完成！安装包已放置到: $OUTPUT_DIR/${NC}"
}

# 构建 Windows 版本
build_windows() {
    echo -e "\n${GREEN}========================================${NC}"
    echo -e "${GREEN}  构建 Windows 版本 (交叉编译)${NC}"
    echo -e "${GREEN}========================================${NC}"
    
    cd "$PROJECT_DIR"
    
    # 检查并添加 Windows GNU 目标
    echo -e "\n${YELLOW}检查 Rust 目标...${NC}"
    if ! rustup target list --installed | grep -q "x86_64-pc-windows-gnu"; then
        echo "添加 x86_64-pc-windows-gnu 目标..."
        rustup target add x86_64-pc-windows-gnu
    fi
    echo "  ✓ x86_64-pc-windows-gnu 已安装"
    
    # 检查 mingw-w64
    echo -e "\n${YELLOW}检查 mingw-w64 工具链...${NC}"
    if ! command -v x86_64-w64-mingw32-gcc &> /dev/null; then
        echo -e "${YELLOW}正在安装 mingw-w64...${NC}"
        if command -v brew &> /dev/null; then
            brew install mingw-w64
        else
            echo -e "${RED}错误: 未找到 mingw-w64，请手动安装: brew install mingw-w64${NC}"
            exit 1
        fi
    fi
    echo "  ✓ mingw-w64 已安装"
    
    echo -e "\n${YELLOW}开始构建...${NC}"
    npm run tauri build -- --target x86_64-pc-windows-gnu
    
    # 复制产物到输出目录（兼容 CARGO_TARGET_DIR / 默认 target）
    echo -e "\n${YELLOW}复制安装包到输出目录...${NC}"

    TARGET_ROOT="${CARGO_TARGET_DIR:-$PROJECT_DIR/src-tauri/target}"
    NSIS_DIR="$TARGET_ROOT/x86_64-pc-windows-gnu/release/bundle/nsis"

    if ls "$NSIS_DIR"/*.exe 1> /dev/null 2>&1; then
        cp "$NSIS_DIR"/*.exe "$OUTPUT_DIR/"
        echo -e "${GREEN}  ✓ $(ls -1 "$NSIS_DIR"/*.exe | xargs -n1 basename)${NC}"
    else
        echo -e "${RED}未找到安装包: $NSIS_DIR${NC}"
        exit 1
    fi

    echo -e "\n${GREEN}Windows 构建完成！安装包已放置到: $OUTPUT_DIR/${NC}"
}

# 显示帮助
show_help() {
    echo "用法: ./build.sh [选项]"
    echo ""
    echo "选项:"
    echo "  windows   构建 Windows 版本 (NSIS 安装包)"
    echo "  macos     构建 macOS 版本 (.app 和 .dmg)"
    echo "  all       构建所有平台版本"
    echo "  help      显示此帮助信息"
    echo ""
    echo "示例:"
    echo "  ./build.sh windows   # 只构建 Windows 版本"
    echo "  ./build.sh macos     # 只构建 macOS 版本"
    echo "  ./build.sh all       # 构建所有版本"
}

# 显示构建结果
show_results() {
    echo -e "\n${GREEN}========================================${NC}"
    echo -e "${GREEN}  构建产物${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo -e "输出目录: ${YELLOW}$OUTPUT_DIR${NC}\n"
    ls -la "$OUTPUT_DIR" 2>/dev/null || echo "输出目录为空"
}

# 主逻辑
main() {
    case "${1:-help}" in
        windows)
            check_dependencies
            build_windows
            show_results
            ;;
        macos)
            check_dependencies
            build_macos
            show_results
            ;;
        all)
            check_dependencies
            build_macos
            build_windows
            show_results
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            echo -e "${RED}未知选项: $1${NC}"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

main "$@"
