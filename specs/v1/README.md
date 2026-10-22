# V1 协议规范

当前尚未冻结精确地图、Action ABI、Hash 编码和 Event 字段。规则冻结以 `plan.md` 第一至第三部分及对应 ADR 为依据。

后续规范统一在开头记录版本、状态、适用 ruleset 和批准 ADR。状态含义：

- **已决定**：已确认的产品/架构边界；变更需要明确决议。
- **候选**：待审阅的具体参数、字段或算法细节，不能当作已批准协议。
- **待验证**：需通过运行结果确定的兼容性、平衡或性能指标。
- **已冻结**：完成审阅并由有效 ADR 记录的精确版本规范。

M0-S2 负责 `GAME_RULES.md`、`STATE_MACHINE.md` 和确定性案例；M0-S3 负责 `ACTION_ENCODING.md`、`STATE_HASH.md`、`EVENTS_API.md`、`THREAT_MODEL.md`、`GAS_BUDGET.md` 及初始 Golden Vectors。

本文件只规定规范组织方式，不补定地图、时限、出生位置或 ABI。
