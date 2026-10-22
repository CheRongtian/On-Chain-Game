# On-chain Tactical Arena

一款正在开发中的双人链上策略战棋游戏。双方在 8×8 棋盘上各控制三名单位，通过隐藏指令、同步行动、技能与据点控制争取胜利。

目前提供 Vue/TypeScript 页面入口、Go 命令入口及 Foundry 编译骨架。游戏规则、钱包连接、正式对局、数据库服务与历史回放尚未实现，当前不能进行比赛。

## 游戏设计

V1 计划提供 Guardian、Ranger、Scout 三种固定职业。玩家通过钱包提交行动承诺，再揭示指令和随机 Salt，由合约同步结算移动、战斗、资源和胜负。V1 不引入 NFT、代币或真实资产。

## 架构

- **Solidity / Foundry**：计划实现唯一权威游戏状态机与确定性战斗结算。
- **Go / PostgreSQL**：计划实现链上索引、重组恢复、独立重演、查询接口与公开阶段推进。
- **Vue 3 / TypeScript / Vite**：应用入口；后续接入 Phaser 4、钱包及历史回放。

正式比赛的写入由玩家钱包直接发往合约，后端只提供辅助服务。完整边界见 [ARCHITECTURE](docs/ARCHITECTURE.md)。

## 本地运行

当前工具基线为 Node 22.23.2、npm 10.9.8、Go 1.25.3、Foundry 1.8.1 和 Solidity 0.8.30。Solidity 编译器可由 Forge 自动管理；本机采用已下载的本地编译器，准备与构建方式见 [DEVELOPMENT](docs/DEVELOPMENT.md)。

首次准备前端依赖：

```sh
cd client
npm install --no-audit --no-fund
```

日常启动在项目根目录的两个终端分别执行以下脚本。

前端：

```sh
./scripts/run-frontend.sh
```

打开终端显示的本地页面，默认地址为 `http://127.0.0.1:5173`。目前页面仅说明项目状态。

后端：

```sh
./scripts/run-backend.sh
```

后端启动、编译和运行的标准输出及错误输出统一写入项目根目录的 `record.log`，每次启动覆盖旧内容，日志文件由 `*.log` 忽略规则排除。当前 Go 入口写入状态说明后退出，尚未启动 HTTP、Indexer 或 Keeper。数据库和本地链当前无需启动。

依赖准备、构建与格式检查命令见 [DEVELOPMENT](docs/DEVELOPMENT.md)。`client/package-lock.json` 已由首次安装生成，后续重新安装使用 `npm ci`。当前采用本地手动构建，CI 暂缓。

## 当前限制

尚无可玩的对局、已部署合约或正式测试网地址。页面不会读取钱包、RPC 或数据库。当前也没有自动化游戏测试及安全审计结果。

原始设计见 [plan.md](plan.md)，阶段任务见 [steps.md](steps.md)。详细开发进度单独记录在 `docs/progress/`。
