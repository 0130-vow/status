# Probe — 极简多机探针系统

一个极简风格的多服务器监控探针。一台中心服务器接收各节点上报的指标数据，Web 仪表盘实时展示，阈值触发时发送邮件告警。

## 架构概览

```
┌──────────────┐     HTTP + JSON      ┌───────────────────┐
│  Agent (N台)  │ ──────────────────→  │  Server (中心)      │
│  Python+psutil│   Bearer Token 认证   │  FastAPI + SQLite   │
└──────────────┘                       │  Jinja2 仪表盘     │
                                       │  邮件告警           │
                                       └───────────────────┘
```

## 采集指标

| 类别 | 指标 | 来源 |
|------|------|------|
| 🖥 系统负载 | CPU 使用率、内存使用率、磁盘使用率 | `psutil` |
| 🌐 网络 | 出入流量 | `psutil.net_io_counters` |
| 🔄 服务存活 | 自定义端口/进程探活 | 配置文件定义 |
| 📅 系统信息 | 主机名、Uptime、操作系统版本 | `platform` / `psutil` |

## 项目结构

```
probe/
├── server/                    # 中心服务端
│   ├── main.py                # FastAPI 应用 + 路由
│   ├── models.py              # SQLite 存储 & 查询
│   ├── config.py              # 服务端配置读取
│   ├── notifier.py            # 邮件告警模块
│   ├── templates/
│   │   └── dashboard.html     # 单页仪表盘
│   └── static/
│       ├── app.js             # 仪表盘交互
│       └── style.css          # 极简样式
├── agent/
│   ├── agent.py               # 采集上报脚本
│   └── config.ini             # Agent 配置（server 地址、token）
├── deploy/
│   └── probe-agent.service    # systemd 示例
├── config.yaml                # 全局配置（阈值、通知等）
├── requirements.txt           # Python 依赖
└── README.md
```

## 快速开始

### 前置要求

- Python ≥ 3.10
- pip

### 1. 中心服务端部署

```bash
# 安装依赖
cd probe
pip install -r requirements.txt

# 修改配置（config.yaml）
# 配置 Agent token、邮件 SMTP 信息及告警阈值

# 启动服务
python -m server.main
# 默认监听 http://0.0.0.0:8000
# 仪表盘地址: http://<server_ip>:8000/
```

### 2. Agent 部署（每台被监控机器）

推荐使用一键脚本：

```bash
# 先在主控机登记节点，并生成 token
ssh straw@140.245.57.96 "bash /home/straw/probe/current/deploy/add-agent.sh --hostname node-02"

# 再在被监控机器执行上一步输出的安装命令
curl -fsSL https://raw.githubusercontent.com/0130-vow/status/main/deploy/install-agent.sh | sudo bash -s -- \
  --server https://status.777702.xyz \
  --hostname node-02 \
  --token <上一步生成的 token> \
  --services "ssh:22,nginx:80"
```

安装脚本会自动处理 `python3`、`pip`、`psutil`、`requests` 等 Agent 依赖，并创建 `probe-agent.service`。

也可以在管理界面生成安装命令：

```text
https://status.777702.xyz/admin
```

使用服务端 `config.yaml` 中的 `server.admin_username` / `server.admin_password` 登录后，填写节点名称和探活项，即可登记节点并生成一键安装命令。

手动部署方式：

```bash
# 安装依赖
cd probe
pip install -r requirements.txt

# 修改配置（config.ini）
# [server]
# host = http://<server_ip>:8000
# token = your_agent_token

# 测试上报（手动运行一次）
python agent.py --once

# 启动定时上报（默认每 60 秒上报一次）
python agent.py

# 或使用 systemd 服务化（推荐）
# 见 deploy/ 下的示例 unit 文件
```

### 3. 查看仪表盘

浏览器打开 `http://<server_ip>:8000/`，即显示所有已上报节点的实时状态。

## API 接口

### `POST /api/report`

Agent 上报指标数据。

**Headers:**
```
Authorization: Bearer <agent_token>
Content-Type: application/json
```

**Body:**
```json
{
  "hostname": "node-01",
  "timestamp": "2026-06-12T09:00:00",
  "cpu_percent": 45.2,
  "memory_percent": 62.1,
  "disk_percent": 78.3,
  "net_sent": 1024000,
  "net_recv": 2048000,
  "uptime_seconds": 360000,
  "services": [
    {"name": "nginx", "status": "running"},
    {"name": "mysql", "status": "running"}
  ]
}
```

### `GET /`

仪表盘页面，展示所有节点最新状态。

### `GET /api/nodes`

返回所有节点最新状态 JSON 数据。

### `GET /api/nodes/{hostname}/history?hours=1`

返回指定节点最近 1、6 或 24 小时的历史指标，用于仪表盘折线图。

## 配置说明

### config.yaml

```yaml
server:
  host: "0.0.0.0"
  port: 8000
  stale_after_seconds: 180
  agents:
    - hostname: "node-01"
      token: "token_xxx"
    - hostname: "node-02"
      token: "token_yyy"

database:
  path: "probe.db"
  retention_days: 30  # 数据保留天数

alert:
  thresholds:
    cpu_percent: 90
    memory_percent: 85
    disk_percent: 85
  cooldown_minutes: 30  # 相同告警间隔

notifier:
  type: smtp
  smtp:
    enabled: false
    host: "smtp.example.com"
    port: 465
    use_ssl: true
    username: "your_email@example.com"
    password: "your_password"
    from_addr: "probe@example.com"
    to_addrs:
      - "admin@example.com"
```

### agent/config.ini

```ini
[server]
host = http://192.168.1.100:8000
token = token_xxx

[collect]
hostname = node-01
interval_seconds = 60
services = nginx:80, mysql:3306, ssh:22
public_ip =
location =
```

## 数据存储

- 使用 SQLite + WAL 模式
- `nodes` 表保存节点最新状态
- `metrics` 表保存历史指标，并按节点和时间建立索引
- 自动清理超过 `retention_days` 的历史数据

## 告警机制

- 每轮上报数据到达时，Server 检查是否超过配置阈值
- 首次触发立即发送告警邮件
- 相同节点的同类告警进入冷却期（cooldown_minutes），避免告警风暴
- 指标恢复正常时发送恢复通知

## License

MIT
