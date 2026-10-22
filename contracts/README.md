# 合约工程

Foundry 和 Solidity 编译设置已建立。`src/BuildInfo.sol` 仅提供真实 Solidity 编译输入，用于确认固定编译器能够处理本工程；它不含游戏状态、外部写入口或部署流程。

从本目录执行 `forge fmt --check` 检查格式。本机已下载 Solidity 0.8.30，使用 `forge build --use ../.local/bin/solc-0.8.30 --offline` 构建已通过；下载方法见 `../docs/DEVELOPMENT.md`。普通 `forge build` 使用 Forge 管理的编译器，缺少版本时会尝试联网下载。

V1 规则和 ABI 尚未冻结。后续先完成 M0-S2/S3，再在 M1 创建正式 Arena 和规则模块。当前没有 Solidity 外部依赖或测试库。
