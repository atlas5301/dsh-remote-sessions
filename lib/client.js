/* Settings/control client for dsh-remote-sessions: one native settings section
 * managing machines and managed virtual workspaces. The interaction follows the
 * dsh-remote settings page (form-based CRUD, a detect action, a status line,
 * remote path autocomplete over ls, DSW design tokens). This is not a chat
 * panel and not a remote-web replacement: sessions, files and terminals run
 * through the unchanged native UI over the backend proxy. */
window.__ModuleLoader__.load({
	id: "dsh-remote-sessions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const NS = "remote-sessions";
		const inject = ["slots", "locale", "workspaces", "sessions"];

		const L = {
			zh: {
				"title": "远程会话",
				"machines.title": "远程主机",
				"machines.name": "名称",
				"machines.ssh": "SSH 目标",
				"machines.node": "Node 路径",
				"machines.socket": "Socket 路径",
				"machines.cwd": "默认远程目录",
				"machines.cli": "DSH CLI 路径（留空自动探测）",
				"machines.plugins": "远程插件（每行 name@version）",
				"machines.chkModels": "同步本地模型配置",
				"machines.chkPluginStates": "同步插件开关状态",
				"machines.sync": "同步插件",
				"machines.syncModels": "同步模型",
				"machines.web": "远程 Web UI",
				"machines.detect": "探测",
				"machines.detecting": "探测中…",
				"machines.save": "保存",
				"machines.delete": "删除",
				"machines.edit": "编辑",
				"machines.check": "检查状态",
				"machines.start": "启动运行时",
				"machines.upgrade": "升级",
				"machines.empty": "尚未配置远程主机。",
				"machines.legacy": "旧版",
				"machines.unlinkConfirm": "以下远程工作区链接的机器不在新列表中：\n{list}\n\n解除链接并保存？",
				"machines.state.running": "运行中",
				"machines.state.stopped": "已停止",
				"machines.state.absent": "未安装",
				"machines.state.unreachable": "不可达",
				"machines.detected": "探测成功：Node {node}（{version}）{cli}",
				"machines.saved": "已保存。",
				"machines.deleted": "已删除。",
				"machines.statusChecked": "状态已刷新。",
				"workspaces.title": "远程工作区",
				"workspaces.machine": "主机",
				"workspaces.path": "远程目录",
				"workspaces.open": "打开工作区",
				"workspaces.opening": "正在打开…",
				"workspaces.unlink": "解除链接",
				"workspaces.newFolder": "新建文件夹",
				"workspaces.create": "创建",
				"workspaces.opened": "已打开 {target} 的 {path}，会话已就绪。",
				"workspaces.empty": "还没有远程工作区。",
				"generic.error": "操作失败：{message}",
				"error.UNKNOWN_MACHINE": "未知主机。",
				"error.MACHINE_IN_USE": "仍有工作区链接到该主机，请先解除链接。",
				"error.REMOTE_CLI_MISSING": "远程未找到 DSH CLI，请检查路径。",
				"error.REMOTE_NPM_MISSING": "远程缺少 npm，无法自动安装 DSH。",
				"error.REMOTE_INSTALL_FAILED": "远程安装 DSH 失败。",
				"error.SSH_UNAVAILABLE": "无法通过 SSH 连接远程主机。",
				"error.INVALID_DIRECTORY_REPLY": "远程目录读取失败。",
				"error.SETTINGS_UNAVAILABLE": "设置服务不可用。",
				"error.INVALID_REQUEST": "请求格式错误。",
				"error.INVALID_MACHINE": "主机配置无效：请检查名称与路径。",
				"error.INVALID_REMOTE_NODE": "Node 路径无效（需绝对路径）。",
				"error.INVALID_SOCKET_PATH": "Socket 路径无效。",
				"error.INVALID_REMOTE_CWD": "默认远程目录无效（需绝对路径）。",
				"error.PROBE_FAILED": "探测失败：SSH 无法返回有效信息。",
				"error.ACTIVE_WORK_PRESENT": "远程仍有会话在运行，已拒绝升级。",
				"error.ACTIVE_WORK_UNVERIFIABLE": "无法确认远程是否空闲，已拒绝升级。",
				"error.RESIDENT_UNSUPERVISED": "该运行时不受本插件管理（无 PID 记录）。"
			},
			en: {
				"title": "Remote Sessions",
				"machines.title": "Machines",
				"machines.name": "Name",
				"machines.ssh": "SSH target",
				"machines.node": "Node path",
				"machines.socket": "Socket path",
				"machines.cwd": "Default remote directory",
				"machines.cli": "DSH CLI path (auto-detected)",
				"machines.plugins": "Remote plugins (name@version per line)",
				"machines.chkModels": "Sync local model settings",
				"machines.chkPluginStates": "Sync plugin toggle states",
				"machines.sync": "Sync plugins",
				"machines.syncModels": "Sync models",
				"machines.web": "Remote web UI",
				"machines.detect": "Detect",
				"machines.detecting": "Detecting…",
				"machines.save": "Save",
				"machines.delete": "Delete",
				"machines.edit": "Edit",
				"machines.check": "Check status",
				"machines.start": "Start runtime",
				"machines.upgrade": "Upgrade",
				"machines.empty": "No remote machines yet.",
				"machines.legacy": "legacy",
				"machines.unlinkConfirm": "These remote workspaces link to machines that are not in the new list:\n{list}\n\nUnlink them and save?",
				"machines.state.running": "Running",
				"machines.state.stopped": "Stopped",
				"machines.state.absent": "Not installed",
				"machines.state.unreachable": "Unreachable",
				"machines.detected": "Detected Node {node} ({version}){cli}",
				"machines.saved": "Saved.",
				"machines.deleted": "Deleted.",
				"machines.statusChecked": "Status refreshed.",
				"workspaces.title": "Remote workspaces",
				"workspaces.machine": "Machine",
				"workspaces.path": "Remote directory",
				"workspaces.open": "Open workspace",
				"workspaces.opening": "Opening…",
				"workspaces.unlink": "Unlink",
				"workspaces.newFolder": "New folder",
				"workspaces.create": "Create",
				"workspaces.opened": "Opened {path} on {target}; the session is ready.",
				"workspaces.empty": "No remote workspaces yet.",
				"generic.error": "Action failed: {message}",
				"error.UNKNOWN_MACHINE": "Unknown machine.",
				"error.MACHINE_IN_USE": "Workspaces still link to this machine; unlink them first.",
				"error.REMOTE_CLI_MISSING": "DSH CLI not found on the remote; check the path.",
				"error.REMOTE_NPM_MISSING": "npm is missing on the remote; cannot auto-install DSH.",
				"error.REMOTE_INSTALL_FAILED": "Installing DSH on the remote failed.",
				"error.SSH_UNAVAILABLE": "SSH could not reach the remote host.",
				"error.INVALID_DIRECTORY_REPLY": "Reading the remote directory failed.",
				"error.SETTINGS_UNAVAILABLE": "The settings service is unavailable.",
				"error.INVALID_REQUEST": "Malformed request.",
				"error.INVALID_MACHINE": "Invalid machine: check the name and paths.",
				"error.INVALID_REMOTE_NODE": "Invalid Node path (absolute required).",
				"error.INVALID_SOCKET_PATH": "Invalid socket path.",
				"error.INVALID_REMOTE_CWD": "Invalid default remote directory (absolute required).",
				"error.PROBE_FAILED": "Probe failed: SSH returned no usable reply.",
				"error.ACTIVE_WORK_PRESENT": "Remote sessions are still running; upgrade refused.",
				"error.ACTIVE_WORK_UNVERIFIABLE": "Cannot verify the remote is idle; upgrade refused.",
				"error.RESIDENT_UNSUPERVISED": "This runtime is not supervised by the plugin (no PID record)."
			}
		};

		// Theme via DSH design tokens, following the harness's own surfaces.
		const v = (name, fb) => `var(${name}, ${fb})`;
		const T = {
			bg: v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
			border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
			danger: v('--dsw-static-red-400', '#e06c75'),
			ok: v('--dsw-static-green-500', '#4caf7d'),
			radius: 8,
			label: v('--dsw-alias-label-primary', '#e4e4e7'),
			primary: v('--dsw-alias-button-primary-fill', '#2563eb'),
			onPrimary: v('--dsw-alias-label-primary-foreground', '#fff'),
		};
		const inputS = { flex: 1, padding: '5px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none', fontSize: 12 };
		const buttonS = { padding: '5px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer', fontSize: 12, flexShrink: 0 };
		const primaryS = { ...buttonS, background: T.primary, borderColor: T.primary, color: T.onPrimary };
		const dangerS = { ...buttonS, color: T.danger };
		const cardS = { border: '1px solid ' + T.border, borderRadius: 10, padding: 14, marginBottom: 14, background: T.bg };
		const LABEL_W = 130;
		const row = (label, control, key) => React.createElement('div', { key, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
			React.createElement('label', { style: { width: LABEL_W, fontSize: 12, opacity: 0.8, flexShrink: 0 } }, label), control);
		const statusLine = (msg, err) => React.createElement('div', { style: { minHeight: 18, fontSize: 12, marginBottom: 8 } },
			err ? React.createElement('span', { role: 'alert', style: { color: T.danger } }, err)
				: React.createElement('span', { style: { color: T.ok } }, msg || ''));

		// The Electron desktop serves the Connection channel under /api; a plain
		// browser uses the admitted webserver routes directly.
		const apiPrefix = typeof window !== 'undefined' && window.location?.protocol === 'dsh-app:' ? '/api' : '';
		async function api(method, path, body) {
			const opts = { method, headers: {} };
			if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
			const res = await fetch(apiPrefix + path, opts);
			const data = await res.json().catch(() => ({}));
			if (!res.ok) { const error = new Error(data.error ?? String(res.status)); error.code = data.error; throw error; }
			return data;
		}
		const get = path => api('GET', path);
		const post = (path, value) => api('POST', path, value ?? {});

		function RemoteSessionsSection({ t, initialState }) {
			// initialState exists for synchronous rendering (tests, previews);
			// production passes nothing and starts from the loading state.
			const seeded = initialState ?? {};
			const [machines, setMachines] = React.useState(seeded.machines ?? null);
			const [workspaces, setWorkspaces] = React.useState(seeded.workspaces ?? []);
			const [runtime, setRuntime] = React.useState(seeded.runtime ?? {});
			const [msg, setMsg] = React.useState('');
			const [err, setErr] = React.useState('');
			const say = text => { setErr(''); setMsg(text); };
			const fail = error => {
				setMsg('');
				let text = t('error.' + error.code) !== 'error.' + error.code ? t('error.' + error.code) : t('generic.error').replace('{message}', String(error.message ?? error));
				if (error.code === 'MACHINE_IN_USE') {
					const linked = workspaces.map(w => `${w.target}:${w.remotePath}`).join(' · ');
					if (linked) text += ` (${linked})`;
				}
				setErr(text);
			};
			const [loadError, setLoadError] = React.useState(seeded.loadError ?? null);
			const reload = React.useCallback(async () => {
				setLoadError(null);
				try {
					const [m, w] = await Promise.all([get('/remote-sessions/machines'), get('/remote-sessions/workspaces')]);
					setMachines(m.machines); setWorkspaces(w.workspaces);
				} catch (reason) { setMachines(false); setWorkspaces([]); setLoadError(reason); }
			}, []);
			React.useEffect(() => { reload(); }, [reload]);
			const machineAction = async (path, value) => {
				try { await post(path, value); await reload(); await checkStatus(); }
				catch (reason) { fail(reason); }
			};
			const checkStatus = async () => {
				try { setRuntime(Object.fromEntries((await get('/remote-sessions/runtime/status')).machines.map(x => [x.name, x]))); }
				catch { /* status stays stale on failure */ }
			};
			return React.createElement('div', null,
				React.createElement(MachinesCard, { t, machines, workspaces, runtime, reload, checkStatus, say, fail, machineAction, msg, err, loadError }),
				React.createElement(WorkspacesCard, { t, machines, workspaces, reload }));
		}

		function MachinesCard({ t, machines, workspaces, runtime, reload, checkStatus, say, fail, machineAction, msg, err, loadError }) {
			// Every configured machine is visible and manageable: active rows run
			// the remote runtime; quarantined legacy rows can only be replaced
			// (same-name save) or deleted. Nothing is hidden from the user.
			const all = Array.isArray(machines) ? machines : [];
			const active = all.filter(m => !m.migrationRequired);
			const legacy = all.filter(m => m.migrationRequired);
			const loading = machines === null || machines === undefined;
			const [form, setForm] = React.useState({ name: '', ssh: '', remoteNode: '', socketPath: '', remoteCwd: '', remoteCli: '', pluginsText: '', syncModels: false, syncPluginStates: false });
			const [busy, setBusy] = React.useState(false);
			const [detected, setDetected] = React.useState(null);
			const editing = form.name !== '' && active.some(m => m.name === form.name);
			const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
		// Machine-name slugging matches the resident-profile convention
		// (machine-registry slugProfileName): underscores collapse to dashes.
		const slugName = value => String(value).toLowerCase().replace(/[_]+/g, '-').replace(/-+/g, '-');
			const detect = async () => {
				setBusy(true); say(''); setDetected(null);
				try {
					const { discovery } = await post('/remote-sessions/machines/discover', { ssh: form.ssh.trim().split(/\s+/).filter(Boolean) });
					setDetected(discovery);
					setForm(current => ({
						...current,
						remoteNode: discovery.node ?? current.remoteNode,
						remoteCwd: discovery.home ?? current.remoteCwd,
						// Only NEW machines get a default socket path: an edited
						// machine keeps its provisioned path — rewriting it here
						// silently orphans the running resident (config drift).
						socketPath: discovery.home && !current.socketPath.trim()
							? `${discovery.home}/.dsh/rs-runtime/${slugName(current.name.trim()) || 'resident'}/agent.sock`
							: current.socketPath,
					}));
				} catch (reason) { fail(reason); }
				setBusy(false);
			};
			const save = async () => {
				setBusy(true); say('');
				const plugins = (form.pluginsText ?? '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
					const at = line.lastIndexOf('@');
					return at > 0 ? { package: line.slice(0, at), version: line.slice(at + 1) } : { package: line };
				});
				// The form edits a subset of the machine record. Fields it does
				// not show (runtime paths, profile, flags, pins) ride along from
				// the record being edited — dropping them would re-default the
				// runtime directories and silently orphan the resident.
				const prior = active.find(m => m.name === form.name.trim());
				const entry = {
					...(prior ? {
						...(prior.runtimeDirectory !== undefined ? { runtimeDirectory: prior.runtimeDirectory } : {}),
						...(prior.residentProfile !== undefined ? { residentProfile: prior.residentProfile } : {}),
						...(prior.remoteHome !== undefined ? { remoteHome: prior.remoteHome } : {}),
						...(prior.authorityRevision !== undefined ? { authorityRevision: prior.authorityRevision } : {}),
						...(prior.autoSetup !== undefined ? { autoSetup: prior.autoSetup } : {}),
						...(prior.npmInstall !== undefined ? { npmInstall: prior.npmInstall } : {}),
						...(prior.dshVersion !== undefined ? { dshVersion: prior.dshVersion } : {}),
						...(prior.modelProvider !== undefined ? { modelProvider: prior.modelProvider, modelId: prior.modelId, ...(prior.effort !== undefined ? { effort: prior.effort } : {}) } : {}),
					} : {}),
					name: form.name.trim(), ssh: form.ssh.trim().split(/\s+/).filter(Boolean),
					remoteNode: form.remoteNode.trim(), remoteCwd: form.remoteCwd.trim(), socketPath: form.socketPath.trim(),
					...(form.remoteCli.trim() ? { remoteCli: form.remoteCli.trim() } : {}),
					// Explicit even when empty: the backend treats a missing key as
					// "keep the previous value" for partial writers.
					plugins,
					syncModels: !!form.syncModels, syncPluginStates: !!form.syncPluginStates,
				};
				const nextMachines = [...active.filter(m => m.name !== entry.name), entry, ...legacy.filter(m => m.name !== entry.name)];
				try {
					await post('/remote-sessions/machines', { machines: nextMachines });
					setForm({ name: '', ssh: '', remoteNode: '', socketPath: '', remoteCwd: '', remoteCli: '', pluginsText: '', syncModels: false, syncPluginStates: false }); setDetected(null);
					await reload(); say(t('machines.saved'));
				} catch (reason) {
					if (reason.code === 'MACHINE_IN_USE' && await confirmUnlink(reason, nextMachines)) { setBusy(false); return; }
					fail(reason);
				}
				setBusy(false);
			};
			// The workspace guard must never dead-end the operator: offer to
			// unlink the orphaned mappings and retry the save in one action.
			const confirmUnlink = async (reason, nextMachines) => {
				const names = new Set(nextMachines.filter(m => !m.migrationRequired).map(m => m.name));
				const orphans = workspaces.filter(w => !names.has(w.target));
				if (!orphans.length || typeof window === 'undefined' || !window.confirm) return false;
				const list = orphans.map(w => `${w.target} → ${w.remotePath}`).join('\n');
				if (!window.confirm(t('machines.unlinkConfirm').replace('{list}', list))) return false;
				try {
					for (const workspace of orphans) await post('/remote-sessions/workspaces/remove', { localPath: workspace.localPath });
					await post('/remote-sessions/machines', { machines: nextMachines });
					setForm({ name: '', ssh: '', remoteNode: '', socketPath: '', remoteCwd: '', remoteCli: '', pluginsText: '', syncModels: false, syncPluginStates: false }); setDetected(null);
					await reload(); say(t('machines.saved'));
					return true;
				} catch (retry) { fail(retry); return true; }
			};
			const remove = async machine => {
				setBusy(true); say('');
				const nextMachines = all.filter(m => m.name !== machine.name);
				try {
					await post('/remote-sessions/machines', { machines: nextMachines });
					if (form.name === machine.name) { setForm({ name: '', ssh: '', remoteNode: '', socketPath: '', remoteCwd: '', remoteCli: '', pluginsText: '', syncModels: false, syncPluginStates: false }); setDetected(null); }
					await reload(); say(t('machines.deleted'));
				} catch (reason) {
					if (reason.code === 'MACHINE_IN_USE' && await confirmUnlink(reason, nextMachines)) { setBusy(false); return; }
					fail(reason);
				}
				setBusy(false);
			};
			const openWeb = async machine => {
				setBusy(true); say('');
				try {
					const response = await post('/remote-sessions/web/open', { target: machine.name });
					if (response.url && typeof window !== 'undefined' && typeof window.open === 'function') window.open(response.url, '_blank');
					else say(response.url ?? '');
				} catch (reason) { fail(reason); }
				setBusy(false);
			};
			const state = name => runtime[name]?.state;
			const canUpgrade = name => runtime[name]?.upgradeAvailable;
			const saveable = Boolean(form.name.trim() && form.ssh.trim() && form.remoteNode.trim() && form.remoteCwd.trim() && form.socketPath.trim());
			if (loading) return React.createElement('div', { style: cardS }, React.createElement('div', { style: { fontSize: 12, opacity: 0.7 } }, t('workspaces.listing')));
			return React.createElement('div', { style: cardS },
				React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
					React.createElement('strong', null, t('machines.title')),
					React.createElement('button', { style: buttonS, onClick: async () => { say(''); await checkStatus(); say(t('machines.statusChecked')); } }, t('machines.check'))),
				loadError !== null && statusLine('', t('generic.error').replace('{message}', String(loadError.message ?? loadError)) + ' '),
				loadError !== null && React.createElement('button', { style: { ...buttonS, marginBottom: 8 }, onClick: () => reload() }, t('machines.check')),
				statusLine(msg, err),
				row(t('machines.name'), React.createElement('input', { style: inputS, value: form.name, onChange: e => set('name', e.target.value), placeholder: 'dl1' }), 'name'),
				row(t('machines.ssh'), React.createElement('div', { style: { display: 'flex', flex: 1, gap: 6 } },
					React.createElement('input', { style: inputS, value: form.ssh, onChange: e => set('ssh', e.target.value), placeholder: 'user@host / ssh-alias / -p 2222 user@host' }),
					React.createElement('button', { style: buttonS, disabled: busy || !form.ssh.trim(), onClick: detect }, busy ? t('machines.detecting') : t('machines.detect'))), 'ssh'),
				row(t('machines.node'), React.createElement('input', { style: inputS, value: form.remoteNode, onChange: e => set('remoteNode', e.target.value), placeholder: '/usr/bin/node' }), 'node'),
				row(t('machines.socket'), React.createElement('input', { style: inputS, value: form.socketPath, onChange: e => set('socketPath', e.target.value), placeholder: '/home/user/.dsh/rs-runtime/<name>.sock' }), 'socket'),
				row(t('machines.cwd'), React.createElement('input', { style: inputS, value: form.remoteCwd, onChange: e => set('remoteCwd', e.target.value), placeholder: '/home/user' }), 'cwd'),
row(t('machines.cli'), React.createElement('input', { style: inputS, value: form.remoteCli, onChange: e => set('remoteCli', e.target.value), placeholder: '/home/user/.npm-global/bin/dsh' }), 'cli'),
				row(t('machines.plugins'), React.createElement('textarea', { style: { ...inputS, minHeight: 54, resize: 'vertical', fontFamily: 'inherit' }, value: form.pluginsText, onChange: e => set('pluginsText', e.target.value), placeholder: '@hytime/dsh-thinking-effort@0.3.6\ndsh-plugin-tool-management@0.18.0' }), 'plugins'),
				row('', React.createElement('div', { style: { display: 'flex', gap: 12, flex: 1 } },
					React.createElement('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
						React.createElement('input', { type: 'checkbox', checked: !!form.syncModels, onChange: e => set('syncModels', e.target.checked) }), t('machines.chkModels')),
					React.createElement('label', { style: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, cursor: 'pointer' } },
						React.createElement('input', { type: 'checkbox', checked: !!form.syncPluginStates, onChange: e => set('syncPluginStates', e.target.checked) }), t('machines.chkPluginStates'))), 'flags'),
				detected?.node && React.createElement('div', { style: { fontSize: 12, color: T.ok, marginBottom: 8 } },
					t('machines.detected').replace('{node}', detected.node).replace('{version}', detected.nodeVersion ?? '?').replace('{cli}', detected.cliBin ? ' · dsh ✓' : '')),
				React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 10 } },
					React.createElement('button', { style: primaryS, disabled: busy || !saveable, onClick: save }, t('machines.save')),
					editing && React.createElement('button', { style: dangerS, disabled: busy, onClick: () => remove(active.find(m => m.name === form.name)) }, t('machines.delete'))),
				React.createElement('div', { style: { border: '1px solid ' + T.border, borderRadius: T.radius } },
					active.map(machine => React.createElement('div', { key: machine.name, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid ' + T.border, fontSize: 12, flexWrap: 'wrap' } },
						React.createElement('strong', { style: { minWidth: 70 } }, machine.name),
						React.createElement('span', { style: { flex: 1, flexBasis: '120px', minWidth: 0, maxWidth: '30%', opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, machine.ssh?.join(' ') ?? ''),
						state(machine.name) && React.createElement('span', { style: { color: state(machine.name) === 'running' ? T.ok : T.danger } }, t('machines.state.' + state(machine.name))),
						React.createElement('button', { style: buttonS, onClick: () => { setForm({ name: machine.name, ssh: (machine.ssh ?? []).join(' '), remoteNode: machine.remoteNode ?? '', socketPath: machine.socketPath, remoteCwd: machine.remoteCwd, remoteCli: machine.remoteCli ?? '', pluginsText: (machine.plugins ?? []).map(p => p.package + (p.version ? '@' + p.version : '')).join('\n'), syncModels: !!machine.syncModels, syncPluginStates: !!machine.syncPluginStates }); setDetected(null); } }, t('machines.edit')),
						(machine.plugins ?? []).length > 0 && React.createElement('span', { style: { opacity: 0.7 } }, 'p:' + machine.plugins.length),
						React.createElement('button', { style: buttonS, disabled: busy, onClick: () => machineAction('/remote-sessions/models/sync', { target: machine.name }) }, t('machines.syncModels')),
						(machine.plugins ?? []).length > 0 && React.createElement('button', { style: buttonS, disabled: busy, onClick: () => machineAction('/remote-sessions/plugins/sync', { target: machine.name }) }, t('machines.sync')),
						React.createElement('button', { style: buttonS, disabled: busy, onClick: () => openWeb(machine) }, t('machines.web')),
						React.createElement('button', { style: buttonS, disabled: busy, onClick: () => machineAction('/remote-sessions/runtime/ensure', { target: machine.name }) }, t('machines.start')),
						canUpgrade(machine.name) && React.createElement('button', { style: buttonS, disabled: busy, onClick: () => machineAction('/remote-sessions/runtime/upgrade', { target: machine.name }) }, t('machines.upgrade')),
						React.createElement('button', { style: dangerS, disabled: busy, onClick: () => remove(machine) }, '✕'))),
					legacy.map(machine => React.createElement('div', { key: machine.name, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 12, opacity: 0.75 } },
						React.createElement('strong', { style: { minWidth: 70 } }, machine.name),
						React.createElement('span', { style: { border: '1px solid ' + T.border, borderRadius: 4, padding: '1px 6px', fontSize: 10 } }, t('machines.legacy')),
						React.createElement('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, machine.ssh?.join(' ') ?? ''),
						React.createElement('button', { style: dangerS, disabled: busy, onClick: () => remove(machine) }, '✕'))),
					all.length === 0 && React.createElement('div', { style: { padding: '8px 10px', fontSize: 12, opacity: 0.7 } }, t('machines.empty'))));
		}

		function WorkspacesCard({ t, machines, workspaces, reload }) {
			// machines is `false` after a failed load: render an empty list, never crash.
			const active = (Array.isArray(machines) ? machines : []).filter(m => !m.migrationRequired);
			const [target, setTarget] = React.useState('');
			const [path, setPath] = React.useState('~');
			const [listing, setListing] = React.useState(null);
			const [suggest, setSuggest] = React.useState([]);
			const [folder, setFolder] = React.useState('');
			const [busy, setBusy] = React.useState(false);
			const [msg, setMsg] = React.useState('');
			const [err, setErr] = React.useState('');
			const say2 = text => { setErr(''); setMsg(text); };
			const fail2 = error => {
				setMsg('');
				let text = t('error.' + error.code) !== 'error.' + error.code ? t('error.' + error.code) : t('generic.error').replace('{message}', String(error.message ?? error));
				if (error.code === 'MACHINE_IN_USE') {
					const linked = workspaces.map(w => `${w.target}:${w.remotePath}`).join(' · ');
					if (linked) text += ` (${linked})`;
				}
				setErr(text);
			};
			const effectiveTarget = target || active[0]?.name || '';
			const ls = React.useCallback(async dir => {
				if (!effectiveTarget) return null;
				const result = await get(`/remote-sessions/ws-ls?machine=${encodeURIComponent(effectiveTarget)}&path=${encodeURIComponent(dir)}`);
				setListing(result);
				return result;
			}, [effectiveTarget]);
			React.useEffect(() => { if (effectiveTarget) { setPath('~'); setListing(null); ls('~').catch(() => setListing(null)); } }, [ls]);
			// Autocomplete: list the typed directory's parent and filter by the
			// final segment, like dsh-remote's remote path input.
			React.useEffect(() => {
				if (!effectiveTarget || !path.trim() || path === '~') { setSuggest([]); return; }
				const timer = setTimeout(async () => {
					try {
						const parent = path.replace(/\/[^/]*$/, '') || '/';
						const result = await get(`/remote-sessions/ws-ls?machine=${encodeURIComponent(effectiveTarget)}&path=${encodeURIComponent(parent)}`);
						const prefix = path.slice(parent === '/' ? 1 : parent.length + 1);
						setSuggest(result.entries.filter(entry => entry.name.startsWith(prefix)).map(entry => entry.path));
					} catch { setSuggest([]); }
				}, 220);
				return () => clearTimeout(timer);
			}, [path, effectiveTarget]);
			const open = async () => {
				setBusy(true); say2(t('workspaces.opening'));
				try {
					const remotePath = listing?.path && path === listing.path ? listing.path : path.trim();
					// A typed path outside the current listing is a new workspace:
					// create it on the remote instead of failing on a missing dir.
					const fresh = remotePath !== listing?.path && !(listing?.entries ?? []).some(entry => entry.path === remotePath);
					const { workspace } = await post('/remote-sessions/workspaces/open', { target: effectiveTarget, remotePath, create: fresh });
					const created = await services.workspaces.create({ path: workspace.localPath });
					await services.sessions.create({ workspaceId: created.workspaceId });
					await reload(); say2(t('workspaces.opened').replace('{path}', workspace.remotePath).replace('{target}', workspace.target));
				} catch (reason) { fail2(reason); }
				setBusy(false);
			};
			const mkdir = async () => {
				if (!folder.trim() || !listing) return;
				setBusy(true); say2('');
				try { const { path: made } = await post('/remote-sessions/ws-mkdir', { machine: effectiveTarget, path: listing.path, name: folder.trim() }); setFolder(''); setPath(made); await ls(made); }
				catch (reason) { fail2(reason); }
				setBusy(false);
			};
			const unlink = async workspace => {
				try { await post('/remote-sessions/workspaces/remove', { localPath: workspace.localPath }); await reload(); }
				catch (reason) { fail2(reason); }
			};
			const pick = entry => { setPath(entry.path); setSuggest([]); ls(entry.path).catch(() => {}); };
			return React.createElement('div', { style: cardS },
				React.createElement('strong', null, t('workspaces.title')),
				statusLine(msg, err),
				row(t('workspaces.machine'), React.createElement('select', { style: { ...inputS, flex: 1 }, value: effectiveTarget, onChange: e => setTarget(e.target.value) },
					active.map(m => React.createElement('option', { key: m.name, value: m.name }, m.name)),
					active.length === 0 && React.createElement('option', { value: '' }, t('machines.empty'))), 'machine'),
				row(t('workspaces.path'), React.createElement('div', { style: { flex: 1, position: 'relative' } },
					React.createElement('input', { style: inputS, value: path, onChange: e => setPath(e.target.value), placeholder: '/home/user/dsh-workspaces/main' }),
					suggest.length > 0 && React.createElement('div', { style: { position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 5, border: '1px solid ' + T.border, borderRadius: T.radius, background: T.bg, marginTop: 2, overflow: 'hidden' } },
						suggest.slice(0, 8).map(s => React.createElement('div', { key: s, style: { padding: '4px 10px', fontSize: 12, cursor: 'pointer' }, onClick: () => pick({ path: s }) }, s)))), 'path'),
				row('', React.createElement('div', { style: { display: 'flex', gap: 6, flex: 1 } },
					React.createElement('button', { style: primaryS, disabled: busy || !effectiveTarget || !path.trim(), onClick: open }, t('workspaces.open')),
					React.createElement('input', { style: inputS, value: folder, onChange: e => setFolder(e.target.value), placeholder: t('workspaces.newFolder') }),
					React.createElement('button', { style: buttonS, disabled: busy || !folder.trim() || !listing, onClick: mkdir }, t('workspaces.create'))), 'actions'),
				listing && React.createElement('div', { style: { border: '1px solid ' + T.border, borderRadius: T.radius, marginBottom: 10, maxHeight: 220, overflow: 'auto' } },
					React.createElement('div', { style: { display: 'flex', gap: 6, padding: '6px 8px', borderBottom: '1px solid ' + T.border, alignItems: 'center' } },
						React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, disabled: !listing.path || listing.path === '/', onClick: () => { const up = listing.path.split('/').slice(0, -1).join('/') || '/'; setPath(up); ls(up).catch(() => {}); } }, '↑'),
						React.createElement('span', { style: { fontSize: 12, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, listing.path)),
					listing.entries.map(entry => React.createElement('div', { key: entry.path, style: { display: 'flex', alignItems: 'center', padding: '4px 10px', fontSize: 12, cursor: 'pointer' }, onClick: () => pick(entry) },
						React.createElement('span', null, '📁 ' + entry.name))),
					listing.entries.length === 0 && React.createElement('div', { style: { padding: '4px 10px', fontSize: 12, opacity: 0.7 } }, '—')),
				workspaces.map(workspace => React.createElement('div', { key: workspace.localPath, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', fontSize: 12, borderBottom: '1px solid ' + T.border } },
					React.createElement('strong', { style: { minWidth: 70 } }, workspace.target),
					React.createElement('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, workspace.remotePath),
					React.createElement('span', { title: workspace.localPath, style: { opacity: 0.6, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 } }, workspace.localPath),
					React.createElement('button', { style: dangerS, onClick: () => unlink(workspace) }, t('workspaces.unlink')))),
				workspaces.length === 0 && React.createElement('div', { style: { fontSize: 12, opacity: 0.7 } }, t('workspaces.empty')));
		}

		/** Client services captured at apply; opening a workspace creates the
		 * native workspace and its first session through the ordinary services. */
		const services = { workspaces: null, sessions: null };

		function apply(ctx) {
			services.workspaces = ctx.workspaces;
			services.sessions = ctx.sessions;
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, L), "remote-sessions: settings dictionaries");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "remote-sessions",
				order: 35,
				label: () => t("title"),
				locale: NS,
				inject: () => ({ t: ctx.locale.bind(NS) })
			}, function RemoteSessionsSettingsSection(props) {
				// initialState is a test/preview seam: production passes nothing.
				return React.createElement(RemoteSessionsSection, { t: props.t ?? t, ...(props.initialState !== undefined ? { initialState: props.initialState } : {}) });
			}));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
