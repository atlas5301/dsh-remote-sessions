# dsh-remote-sessions — 独立的原生会话后端

[English](README.md) | 中文

通过**完全不变的现有 DSH 工作区、会话、输入框、审批与历史界面**来运行远程 DSH 智能体。本包没有客户端入口、自定义聊天面板、远程 Web 应用、浏览器依赖，也不依赖 `dsh-remote`。

```text
现有原生 DSH 前端（保持不变）
                  │ 普通会话 API
本地仅元数据会话 + 后端代理
                  │ 严格 SSH / 有界协议
独立托管的远程 DSH + companion
                  │
远程 AgentLoop、模型、工具、文件与持久化
```

## 安装

安装到一个 DSH profile 中（本插件是纯后端包；原生 UI 保持不变）：

```sh
dsh plugin --profile web add dsh-remote-sessions     # 或：--profile desktop
```

然后重启该 profile 的运行时，打开 **Settings → Remote Sessions** 添加机器。以上是官方安装渠道；下面的替代方式同样可用：

- **npm**：在 profile 中 `npm install dsh-remote-sessions`，或用 `dsh plugin --profile web add npm:dsh-remote-sessions@0.8.3` 固定版本。
- **GitHub**：`dsh plugin --profile web add github:atlas5301/dsh-remote-sessions`（[releases](https://github.com/atlas5301/dsh-remote-sessions/releases) 中对每个已发布版本打了标签）。
- **插件市场**：在 [DSH Plugin Hub](https://dsh-plugin.org) / Settings → Plugin Hub 中搜索 "dsh-remote-sessions"，从目录安装。

要求两端均为 DSH **0.2.0-rc.2 及以上（0.2.x）**，Node 22.15+。SSH 必须能非交互认证（密钥或 agent）到远程机器，且使用与运行时目录属主相同的 Unix 用户。

**0.8.4 版本状态：** 源码已实现，已针对已安装的 DSH **0.2.0-rc.2** 用隔离的真实运行时完成测试，并已在一台真实远程主机上通过严格 SSH 完成端到端验证（部署、模型/凭据同步、会话代理、文件树、终端、升级与重启流程）。

## 自动远程部署

常驻运行时（resident）的生命周期由插件自身管理。本地安装插件绝不触碰 SSH；首次使用某台已配置的机器时，传输层先尝试严格 SSH 中继，若私有套接字不存在，部署门面会在一次重试前执行：

1. **探测**（只读 SSH 探测）：node 版本、已安装的 DSH CLI 路径/版本、常驻标记文件（`<runtimeDirectory>/resident.json`）、私有套接字及其记录的 PID。
2. **复用**：正在服务的套接字绝不会被停止、替换或重写。
3. **启动**：已部署但已停止的常驻运行时用其记录的 CLI 启动；不改动任何文件。
4. **部署**：缺失的常驻运行时会被创建——私有目录、通过 stdin（tar）上传的内置常驻包、一个由 `@deepseek-ai/dsh-base` + 常驻包组成的 profile，以及写入 PID 的脱离式启动（`setsid`，回退 `nohup`）。当没有 DSH CLI 时，`npm install -g @deepseek-ai/dsh@<版本>` 会固定为与本地运行时相同的版本。

版本管理保持显式且有保护：`GET /remote-sessions/runtime/status` 报告每台机器的运行时/node/包版本与可升级状态；`POST /remote-sessions/runtime/ensure` 和 `POST /remote-sessions/runtime/upgrade` 只作用于单台机器。当远程会话仍在运行（`ACTIVE_WORK_PRESENT`），或正在服务的套接字无法验证、未通过记录的 PID 托管（`ACTIVE_WORK_UNVERIFIABLE`、`RESIDENT_UNSUPERVISED`）时，升级会被拒绝；升级只停止该记录的 PID，重新部署并重启，此后旧绑定像任何远程进程重启后一样安全关闭。在机器上设置 `autoSetup: false` 可完全退出自动部署；`npmInstall: false` 禁止远程 npm 安装。

用于生命周期管理的机器字段（`remoteCli`、`remoteHome`、`residentProfile`、`runtimeDirectory`、`dshVersion`、`autoSetup`、`npmInstall`）**不属于**执行授权的一部分：仅修改部署字段时，既有绑定保持其固定的身份。

## 设置页与托管工作区

本插件提供一个**原生设置分区**（"Remote Sessions"）以及支撑它的后端。没有聊天面板、侧边栏入口或工作区选择器接管——会话、文件树和终端全部通过不变的原生 UI 运行。

**机器（Machines）卡片**：按名称与 SSH 目标添加机器，点击 *Detect*（一次只读 SSH 探测即可发现 Node 路径/版本、npm 以及任何已安装的 DSH CLI，并为套接字与目录填入安全默认值）。*Start* 执行自动部署；当内置常驻包比已安装的版本更新时出现 *Upgrade*，且远程工作仍在进行时会拒绝升级。移除仍挂有工作区的机器会被拒绝。

**远程工作区（Remote workspaces）卡片**：*Open remote workspace* 打开一个基于严格 SSH 的浏览对话框（机器 → 目录 → 可选新建文件夹 → 打开）。打开时：

1. 在远程 DSH 上创建**真实工作区**（转发的 `workspace/create`，幂等）；
2. 关联一个**插件托管的本地锚点**（`~/.dsh/remote-sessions/anchors/…`）——用户无需创建任何东西；
3. 启动原生工作区及其第一个会话，由普通 UI 接管。

每台机器多个工作区、多台机器均为一等公民：每个映射都是一个托管锚点 ↔ 一个远程目录。解除关联只移除映射；锚点与远程工作区保留。

请选择能为常驻运行时的沙箱提供真实边界的远程工作区根目录——例如每个项目 `~/dsh-workspaces/<名称>`。以整个家目录作为远程工作区根目录没有跨工作区写保护，不推荐。

偏好的操作员仍可使用手工 YAML 配置：

```yaml
- id: remote-sessions
  config:
    machines:
      - name: build-host
        ssh: [user@build-host]
        remoteNode: /usr/bin/node
        socketPath: /home/user/.dsh/rs-runtime/agent.sock
        remoteCwd: /srv/project
        authorityRevision: '1'
    workspaces:
      - localPath: /absolute/local/remote-project-anchor
        target: build-host
        remotePath: /srv/project
```

请使用无符号链接别名的规范绝对目录。更具体的已配置根目录优先。设置页的机器/工作区写入经过相同校验（`machine-registry`），并通过 DSH 的设置服务持久化到该配置中，两个视图保持一致。本地锚点**不是**同步镜像，也绝不承载远程智能体。相对路径 `@file` 补全向远程会话查询。上传的文件被传输到远程附件存储。

映射只作用于新建会话。既有的本地会话不会被静默迁移为远程所有权。即使后续修改配置，已持久化的代理绑定仍保留其确切的机器授权、运行时 UUID、进程实例、会话 ID 与目录。

### 可选的 dsh-remote 兼容

`dsh-remote` 是后端服务覆盖模式的参考，不是依赖。如果你已经在使用它，可显式启用兼容：

```yaml
mirrorTargets:
  - target: build-host
    alias: my-ssh-alias
# mirrorRoot 默认为 $DSH_HOME/remote-workspaces
```

精确的 `host`、`username`、`port` 元组可替代 `alias`。有歧义/未配置的镜像会拒绝远程路由。没有 `mirrorTargets` 时，其元数据永远不会被查询。

## 常驻运行时准备

远程智能体必须独立于本地 GUI 与 SSH 进程。不要用一次性 headless 任务、ACP 子进程、远程 Web 服务器或桌面子进程作为它的宿主。

[准备脚本](<tools/prepare-resident.mjs>)创建**全新的**私有 profile/运行时目录和一个 systemd user-unit 模板。它绝不启动、启用、重启、杀死、删除或替换任何已存在的运行时。

```sh
node /absolute/plugin/tools/prepare-resident.mjs \
  --home /home/user/.dsh \
  --profile remote-resident \
  --runtime-directory /home/user/.dsh/rs-runtime \
  --node /absolute/path/to/node \
  --cli /absolute/path/to/@deepseek-ai/dsh/lib/bin.js
```

home 目录、其 `profiles` 目录以及运行时目录的父目录必须已存在且属主为操作员本人。套接字路径不得超过 100 个 UTF-8 字节。companion 使用私有 Unix 套接字；不需要任何远程 TCP/Web 监听。SSH 以同一 Unix 用户认证，启用严格主机密钥检查与非交互式认证。

安装/启动生成的 profile 与服务模板前请先审阅。模板使用 `Restart=no`：远程崩溃后，残留套接字应当被排查，而不是盲目删除。注销/重启监管是独立的操作系统配置选择。请显式配置远程模型与凭据；插件绝不在启动时复制完整存储、记忆或凭据。

该 profile 组合 DSH base 与 companion 包。普通的 base 策略/插件照常生效；这并不代表 DSH 遥测或无关插件被禁用。

## 已实现的原生操作

- 普通的工作区成员关系与 create/list/search/history/follow 会话操作。
- 文本/图像提示词转发、队列变更、重命名与显式停止。
- 实时助手帧与持久化日志事件，除映射的会话头外保持不变。
- 原生编码上传与既有的原始二进制上传路由，使用有界的 192 KiB 中继分块与远程持有的回执。
- 原生审批与结构化问答瀑布流，包括客户端重连回放、限时等待挂接与延迟答复转发。
- 原生控制投影、活动/状态通知、远程 `@file` 补全与命令发现/执行。
- **远程文件树**：`workspaceFiles` 的 list/read/readBytes/stat/changes 转发到远程会话的文件系统。会话相对路径按远程工作区根解析；本地锚点下的绝对路径映射为其远程相对形式。二进制读取以 base64 标记附件的形式跨越 JSON 中继，并在原生回复前解码回字节。远程监视听式推送实时变更帧；远程绑定会话绝不列出或读取本地文件。
- **远程终端**：整个 `terminalController` 表面（environment、shells、create、follow、retain、write、resize、rename、close、list）转发到远程 PTY。屏幕恢复、独占输入附件与保留终端的行为与本地会话完全一致；输入控制由远程控制器强制执行。
- 原生模型选择与合并的模型目录。**DSH 的模型选择同样会保存该运行时的默认值**，与其普通 API 一致。本插件只转发显式的用户模型选择操作；不会自动应用旧版机器模型固定字段。
- 持久化代理绑定、恢复的元数据外壳，以及本地主机重启后的重新挂接，不创建本地 Agent、不重放变更。

## 远程会话的模型选择

在输入框为远程绑定会话选择模型时，`session/selectModel` 会被转发到常驻运行时——远程会话的选择器与本地完全一致地响应，选择会持久化在远程日志中（`model/selection`）。有两个不对称性值得了解：

- **主机专属 provider**：`baseURL` 指向环回服务器（例如本地 `omlx` 的 `127.0.0.1:8000`）的 provider 会作为配置同步过去，但常驻运行时只能访问它自己主机上的服务器。为远程会话选择这类模型会成功安装选择、随后在模型调用本身失败——远程会话请选择远端可达的 provider。
- **失败的选择绝不静默**：被常驻运行时拒绝的选择（例如不支持的推理档位）会透传远端错误，并通过原生的会话错误通道呈现。会吞掉错误的第三方输入框组件也无法掩盖它。

## 失败与兼容边界

- 关闭本地 UI、SSH 掉线或本地主机退出不会取消远程工作。只有显式取消才会。远程存续要求其常驻进程与外部资源保持存活。
- 丢失的变更确认会以"结果未知"上报。重新提交前请检查权威的远程历史。没有自动提示词重放，也没有恰好一次（exactly-once）保证。
- 远程进程重启会改变其实例 ID，而会话存储持久存在。传输层只有在验证绑定的远程会话仍然存在后才会采纳新实例（进行中的变更已以未知结果呈现）；运行时身份变化仍然安全关闭。显式升级在验证无活动工作后执行同样的受保护重启。
- 自动部署只创建或启动：绝不停止、删除或替换运行中的常驻运行时。升级只停止运行时目录中记录的 PID，并在远程工作处于活动或不可验证状态时拒绝执行。没有记录 PID 的服务中套接字（`RESIDENT_UNSUPERVISED`）属于操作员监管的运行时，绝不会被触碰。
- 本地草稿保留由原生 DSH 提供；本后端不添加浏览器存储或替代性的乐观消息逻辑。
- 针对远程绑定会话，原生文件树与终端**确实**虚拟化到远程会话的资源上；本地会话保持其普通本地行为。原生桌面文件打开动作仍是本地的，不会被转发。
- 远程 fork 创建与完整的交互式子智能体管理 API 未实现；可转发合格的子级历史，但不宣称完全对等。不支持的 Agent 操作被禁止在本地执行。
- 显式的选择性同步/传输后端端点保持可用，带有预览/冲突保护；没有替代的自定义 UI。没有记忆/完整 provider/OAuth 存储的同步、清理或自动同步。
- 主机级模型目录是一个并集；目标可用性由所属运行时在选择时验证。相同的 provider/模型名在不同主机上可能暴露不同的推理选项。

后端包装公开的服务实例并使用生成的 Gateway 描述符。它不修改任何已安装的 DSH 源文件、全局前端传输或原生前端组件。这些是对版本敏感的集成缝隙——不保证每个未来的 0.2 版本都兼容。升级时请重新运行集成测试。

## 测试

```sh
npm test
DSH_TEST_RUNTIME_ANCHOR=/absolute/installed/@deepseek-ai/dsh/package.json npm run test:runtime
```

请使用 Node 22.15+（测试解析器使用 `registerHooks`）。部分保留的 YAML 夹具使用 `DSH_SELECTED_SYNC_YAML_PATH`；主机测试接受 `DSH_TEST_DEPENDENCY_ANCHOR`/`DSH_TEST_RUNTIME_ANCHOR`。在已安装兼容 CLI 的情况下，无需安装依赖或模型凭据。

当前发布门槛：在 DSH 0.2.0-rc.2 上 **229 项后端/契约测试（含 20 项操作员行为回归测试）+ 11 项已安装运行时/profile 测试全部通过**。运行时测试覆盖会话代理、自动部署生命周期脚本（纯脚本化 SSH）、远程文件树转发（针对真实远程文件的 list/read/readBytes/stat/changes，包括字节精确的二进制读取与实时监听）以及远程终端（在真实远程 PTY 上的 create/write/follow/resize/rename/close）。

### 操作员行为回归套件

[test/behaviour-regressions.test.js](<test/behaviour-regressions.test.js>) 固定了线上 v0.8.0 安装的每一项操作员报告的故障；每个测试都先在带缺陷的已发布代码上验证会**失败**，再在修复后通过：

- **Sync models 报 "Action failed: BACKEND_ERROR"** —— `syncModelsToRemote` 的 home 补丁步骤中的 TDZ `ReferenceError`（已安装的 0.8.0 在首次使用之后才声明 `remoteDshHome`）。该套件完整执行该函数，覆盖 home 层补丁与凭据步骤，断言凭据经 stdin 传输（绝不出现在 SSH 命令行上，新存储使用 `umask 077`），并驱动真实的 `/remote-sessions/models/sync` 路由：健康流程 200、SSH 不可达时呈现命名错误码、内部错误仍映射为 BACKEND_ERROR。
- **"无法连接远程工作区"（配置漂移）** —— 设置页的 Detect/Edit 用原始机器名重写了 `socketPath` 并丢弃了表单外的机器字段；已停止的常驻运行时带着过期的 profile 补丁被盲目重启并绑定到别处，而传输层连接的是配置路径。该套件固定：`ensure()` 对标记**或** profile 补丁 `runtimeDirectory` 发生漂移的已停止常驻运行时执行重新部署（标记漂移与补丁漂移是两种情况）、对一致的运行时执行不重新上传的廉价启动、设置面板 Detect 绝不重写既有套接字路径（只为新机器填入按规则转换的默认值）、Edit+Save 保留每个表单外的机器字段（后端同样如此：缺省键表示"未变更"，显式 `plugins: []` 表示清空）。
- **Sync models 不生效（模型配置被抹除）** —— 生命周期部署流程重新生成常驻 profile 补丁时**没有**带上显式同步刚写入的 provider 小节，且插件签名报告 "in-sync"，导致常驻运行时从不重新加载。`readLocalEnvironment` 现在同时读取本地 profile 的 `llm-pi-ai` 小节，`profilePatchText` 携带它，且部署签名覆盖 插件 + 模型目录 + 插件状态，因此目录变化强制重新部署+重启，未变化则保持无操作。
- `machines: false`（加载失败）状态不再导致设置分区渲染崩溃。
- **第二轮**（见 [FIXES-0.8.2.md](<FIXES-0.8.2.md>)）：每个 provider 的 API key 都会同步
  （omlx）；会话行为可选包（auto-review、agent-team-profile）固定部署到常驻运行时
  （CLI 内置包只通过 bundles 列表组合、绝不 npm 安装——0.8.3 修复了 npm 安装复制整个
  模块树导致"SessionQueryError: session not found"的问题）；远程创建的工作区会话被
  采纳进本地界面；实例 ID 变化在验证会话仍存在后被采纳；常驻运行时拥有其运行时目录
  下的专属凭据存储——远端的共享 home 永远不会被写入。

独立集成测试启动两个分离的真实 DSH 进程，使用确定性 mock 模型、无网络模型调用且不依赖 `dsh-remote`。它检查原生工作区成员关系、模型控制、字节精确的远程上传、审批/问答、取消、持久化绑定重开、本地主机完整重启后对**同一活动尝试**的重新挂接，以及离线安全关闭时本地会话仍然可用。传输层使用真实 Unix 套接字；SSH 帧/配置有独立测试。不使用、也不需要浏览器。

被拒绝的自定义前端与历史测试仅保留在开发树中；发布清单不注册/导出/打包该客户端。详见[实现细节](<IMPLEMENTATION.md>)。
