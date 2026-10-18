# Windows 本地补丁说明

上游：`atlas5301/dsh-remote-sessions` v0.8.11（MIT）。
本目录是本地 vendored 副本，用来在 Windows 本机跑起来并自行维护。

## 问题

上游插件默认假设**本机**是 POSIX 环境：

- `lib/transfer-actions.js` 的 `absolute()` 要求路径以 `/` 开头。
- `native-host.js` 在激活时无条件调用 `installTransferActions()`，它用
  `homedir()`（Windows 上是 `C:\Users\...`）做校验，直接抛 `INVALID_ROOT`，
  导致整个插件激活失败、所有 `/remote-sessions/*` 路由不存在，界面上表现为
  设置页 404。

## 改法

`lib/native-host.js` 与 `lib/index.js`：在 `win32` 上跳过可选的
`installTransferActions()`（显式选择文件推送功能）。其余功能（会话、文件树、
终端、审批、模型同步）不受影响。

```js
if (process.platform !== 'win32') {
  installTransferActions(ctx, registry, { sshExchange, registerRoutes });
}
```

## 升级上游时怎么办

1. `git fetch && git checkout <新 tag>`；
2. 重放上面两处 `win32` 判断；
3. 在 web profile 上先验证：`dsh --profile web --no-open --port 3082`，
   stderr 不应再出现 `did not activate`；
4. 没问题再切 desktop profile。

## 已知仍不支持

- 显式 selected-transfer / selected-sync（代码里本就有 `POSIX_PROTECTION_REQUIRED` 守卫）。
- 本地锚点目录只是占位，不是镜像。
