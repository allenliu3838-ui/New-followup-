# [Runbook] <告警名称>

> 复制此模板并填写每个章节。未填写字段请保留占位符，不要删除章节。

---

## 基本信息

| 字段 | 值 |
|---|---|
| 告警 ID | KSR-ALERT-XXXX |
| 严重度 | P0 / P1 / P2 |
| 关联任务 | KSR-XXXX |
| 影响旅程 | `/p/<token>` 提交 / `/staff` 登录 / 导出 / 快照 / 其他 |
| 创建日期 | YYYY-MM-DD |
| 最后更新 | YYYY-MM-DD |
| 负责人 | @role |

---

## 触发条件

```
指标：<SLI 指标名，例如 kidneysphere_token_submit_error_rate>
阈值：<例如 > 0.02（2%）>
时间窗口：<例如 5 分钟滑动窗口>
告警表达式（Prometheus 示例）：
  rate(token_submit_errors_total[5m]) / rate(token_submit_requests_total[5m]) > 0.02
```

---

## 业务影响

- **用户影响**：<例如：患者无法提交随访数据>
- **数据影响**：<例如：录入丢失、审计断链>
- **合规影响**：<例如：随访链接泄露、PII 暴露风险>

---

## ⏱ 5 分钟内应急动作（先止血）

按顺序执行，确认每步结果后再进行下一步。

1. **确认告警非误报**
   ```bash
   # 查看最近 10 条错误日志
   # <日志平台查询命令或 Grafana 面板链接>
   ```

2. **若疑似 Token 滥用** — 批量撤销异常 token
   ```bash
   # psql $DB_ADMIN_URL -c "UPDATE tokens SET revoked_at=NOW() WHERE <条件>;"
   # 需 DB 权限（需凭证）
   ```

3. **若疑似发布导致** — 执行回滚
   ```bash
   # git revert HEAD && git push  # 或触发 CI/CD 回滚流水线
   ```

4. **若数据库饱和** — 暂停重任务（导出/论文包生成）
   ```bash
   # <暂停导出队列命令>
   ```

---

## 🔍 定位路径（按顺序）

### Step 1：四黄金信号看板

打开 Grafana 仪表盘 `core_golden_signals`，检查：
- **延迟**：p95 / p99 是否异常上升？
- **流量**：RPS 是否突增或骤降？
- **错误**：错误率分布（4xx vs 5xx）？
- **饱和**：DB 连接池 / CPU / 磁盘是否打满？

### Step 2：日志检索（关键字段）

```
# 按 trace_id 关联链路
trace_id: <从告警上下文获取>

# 按入口过滤
endpoint: "/p/*" OR endpoint: "/staff"

# 按时间缩小范围
timestamp: [<告警触发时间 - 5min> TO <告警触发时间 + 10min>]
```

### Step 3：最近变更记录

```bash
git log --oneline -10
# 或查看 CI/CD 最近一次部署记录
```

### Step 4：数据库诊断

```sql
-- 慢查询
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active' AND now() - query_start > interval '5 seconds'
ORDER BY duration DESC;

-- 连接池
SELECT count(*), state FROM pg_stat_activity GROUP BY state;

-- 锁等待
SELECT blocked_locks.pid, blocking_locks.pid AS blocking_pid
FROM pg_locks blocked_locks
JOIN pg_locks blocking_locks ON blocking_locks.granted
  AND blocked_locks.relation = blocking_locks.relation
WHERE NOT blocked_locks.granted;
```

---

## 🔧 修复与验证

1. 执行修复步骤：`<填写>`
2. 验证 SLI 恢复：`<对应指标恢复到 SLO 范围内>`
3. 执行关键回归用例：`<测试命令或测试用例 ID>`
4. 确认审计日志完整（无断链）

---

## 📢 对外沟通模板

```
[状态更新 - HH:MM UTC]
影响：<简述影响面与用户操作>
当前状态：<正在定位 / 已识别根因 / 修复中 / 已恢复>
预计解决时间：<HH:MM UTC 或"持续跟进">
下次更新：<HH:MM UTC>
```

---

## 📝 复盘（事后填写）

| 字段 | 内容 |
|---|---|
| 根因 | |
| 检测时间（MTTD） | |
| 恢复时间（MTTR） | |
| 影响时长 | |
| 数据影响（行数/用户数） | |
| 预防措施 | |
| 行动项 | `[ ] 描述 @owner YYYY-MM-DD` |

---

*模板版本：v1.0 · 参考 Google SRE Book / NIST SP 800-61r3*
