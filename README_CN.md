# CF-WORKER-TEXT2KV

基于 Cloudflare Workers + KV 的在线文本文件管理和分发系统。通过 Web 管理后台管理文本文件，并通过公开 URL 分享 —— 适用于在多设备间同步配置文件、订阅列表或任何文本内容。

## 截图

### 桌面端

![桌面端](screenshot/desktop.png)

### 移动端

<p float="left">
  <img src="screenshot/mobile-1.png" width="280" />
  <img src="screenshot/mobile-2.png" width="280" />
</p>

## 功能特性

- **Web 管理后台** — 文件增删改查，集成 [Ace Editor](https://ace.c9.io/) 代码编辑器（语法高亮、行号、代码折叠）
- **公开文件访问** — 通过 `https://your-domain.com/f/{filename}` 分享文件，始终返回最新内容
- **响应式设计** — 桌面端双栏布局 + 移动端双视图切换
- **深色 / 浅色主题** — 持久化到 localStorage
- **JSON / YAML 格式化** — 编辑器内一键格式化
- **导入 / 导出** — JSON 批量备份和恢复（Base64 编码内容）
- **搜索** — 按标题或文件名实时过滤文件列表
- **脏状态跟踪** — 未保存更改标记，切换时弹出确认提示
- **快捷键** — `Ctrl/Cmd+S` 保存

## 技术栈

- **运行时**: Cloudflare Workers
- **存储**: Cloudflare KV
- **认证**: 自定义登录页 + SHA-256 Cookie Token
- **前端**: 单文件内联 HTML/CSS/JS，CDN 依赖（Lucide Icons、Ace Editor、js-yaml、Google Fonts）

## 部署指南

### 1. 前置条件

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/)（或 npm/yarn）
- [Cloudflare 账号](https://dash.cloudflare.com/)

### 2. 克隆并安装

```bash
git clone https://github.com/ofeiss/cf-worker-text2kv.git
cd cf-worker-text2kv
pnpm install
```

### 3. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create TEXT_STORE_KV
```

记下返回的命名空间 ID。

### 4. 配置

复制示例配置并填入 KV 命名空间 ID：

```bash
cp wrangler.example.toml wrangler.toml
```

编辑 `wrangler.toml`，将 `YOUR_KV_NAMESPACE_ID` 替换为实际 ID。

### 5. 设置管理密码

```bash
npx wrangler secret put ADMIN_PASSWORD
```

按提示输入密码。

### 6. 部署

```bash
npx wrangler deploy
```

### 7. 本地开发

创建 `.dev.vars` 文件：

```
ADMIN_PASSWORD=你的密码
```

启动开发服务器：

```bash
pnpm dev
```

## 路由说明

| 路径 | 方法 | 功能 | 认证 |
|------|------|------|------|
| `/` | GET | 管理后台（或登录页） | 需要 |
| `/f/{filename}` | GET | 公开访问文件（纯文本） | 不需要 |
| `/api/files` | GET | 获取文件列表 | 需要 |
| `/api/files` | POST | 创建文件 | 需要 |
| `/api/files/{id}` | GET | 获取文件详情 | 需要 |
| `/api/files/{id}` | PUT | 更新文件 | 需要 |
| `/api/files/{id}` | DELETE | 删除文件 | 需要 |
| `/api/export` | GET | 导出所有数据为 JSON | 需要 |
| `/api/import` | POST | 批量导入 JSON 数据 | 需要 |
| `/api/login` | POST | 登录 | 不需要 |
| `/api/logout` | POST | 退出登录 | 不需要 |

## 许可证

MIT
