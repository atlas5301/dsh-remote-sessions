/* Only local connection controls are added to the remote's native client graph.
 * Business operations below use its existing native services, never a local DB. */
window.__ModuleLoader__.load({
  id: 'dsh-remote-sessions-wrapper',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const host = window.__DSH_REMOTE_HOST__
    const button = { padding: '5px 9px', borderRadius: 6, border: '1px solid #71717a', background: '#27272a', color: '#fafafa', cursor: 'pointer' }
    function Picker({ open, busy, onPicked, onCancel }) {
      const [path, setPath] = React.useState('')
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!open) return
        const before = document.activeElement
        ref.current?.focus()
        return () => before?.isConnected && before.focus()
      }, [open])
      if (!open) return null
      return createPortal(React.createElement('div', { style: { position: 'fixed', inset: 0, background: '#0008', zIndex: 10000, display: 'grid', placeItems: 'center', padding: 16 }, onClick: e => { if (e.target === e.currentTarget && !busy) onCancel() } },
        React.createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': 'Remote workspace directory', style: { background: '#18181b', color: '#fafafa', padding: 20, borderRadius: 12, width: 'min(520px,100%)', boxSizing: 'border-box' } },
          React.createElement('h3', null, 'Remote workspace · ' + host.name),
          React.createElement('p', null, 'Select an existing absolute directory on the remote machine. No local workspace or mirror is created.'),
          React.createElement('input', { ref, 'aria-label': 'Remote directory', value: path, disabled: busy, onChange: e => setPath(e.target.value), onKeyDown: e => { if (e.key === 'Enter' && path.startsWith('/') && !busy) onPicked(path); if (e.key === 'Escape' && !busy) onCancel() }, style: { width: '100%', boxSizing: 'border-box', padding: 8, marginBottom: 12 }, placeholder: '/home/ubuntu/ws-test' }),
          React.createElement('button', { style: button, disabled: busy || !path.startsWith('/'), onClick: () => onPicked(path.trim()) }, busy ? 'Opening…' : 'Open remote workspace'),
          React.createElement('button', { style: { ...button, marginLeft: 8 }, disabled: busy, onClick: onCancel }, 'Cancel'))), document.body)
    }
    function Header({ connection }) {
      const state = React.useSyncExternalStore(connection.state.subscribe, connection.state.getSnapshot)
      const generation = React.useSyncExternalStore(connection.generation.subscribe, connection.generation.getSnapshot)
      const connected = generation !== undefined && state === 'connected'
      const label = connected ? 'Connected' : 'Reconnecting / disconnected — no local fallback'
      return createPortal(React.createElement('div', { 'data-remote-runtime': host.name, role: 'status', style: { position: 'fixed', top: 8, right: 12, zIndex: 9990, font: '12px system-ui', padding: '6px 8px', borderRadius: 8, border: '1px solid #71717a', color: '#fafafa', background: '#18181bef', maxWidth: 'calc(100vw - 24px)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
        React.createElement('strong', null, 'Remote runtime · ' + host.name),
        React.createElement('span', { title: state ? JSON.stringify(state) : '' }, label),
        React.createElement('button', { style: button, onClick: () => connection.reconnect() }, 'Reconnect'),
        React.createElement('button', { style: button, onClick: () => { window.location.href = '/' } }, 'Return to local')),
        document.body)
    }
    function apply(ctx) {
      ctx.inject(['slots', 'connection'], inner => {
        const slots = inner.get('slots'), connection = inner.get('connection')
        slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'ssh-remote-identity', order: -100 }, () => React.createElement(Header, { connection })))
        for (const slot of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
          slots.inject(slot, () => slots.register({ name: slot, id: 'ssh-remote-directory', priority: -200 }, Picker))
        }
      })
      const requested = new URLSearchParams(window.location.search).get('workspace')
      if (!requested || window.__DSH_REMOTE_WORKSPACE_INTENT_CONSUMED__) return
      // Consume BEFORE any mutation, across injection/graph reloads. Reloading
      // the page cannot repeat an uncertain create because the URL is cleared.
      window.__DSH_REMOTE_WORKSPACE_INTENT_CONSUMED__ = true
      const clean = new URL(window.location.href); clean.searchParams.delete('workspace'); history.replaceState(null, '', clean)
      let started = false
      ctx.inject(['uiWorkspace', 'workspaces'], inner => {
        if (!requested.startsWith('/') || requested.includes('\0')) return
        const workspaces = inner.get('workspaces'), ui = inner.get('uiWorkspace')
        let stopped = false, notice
        const open = async () => {
          const snapshot = workspaces.list.getSnapshot()
          if (started || stopped || snapshot.phase !== 'ready') return
          started = true
          try {
            const existing = snapshot.items.find(w => w.path === requested)
            const workspace = existing || await workspaces.create({ path: requested })
            if (!stopped) await ui.openWorkspace(workspace.workspaceId)
          } catch (error) {
            if (stopped) return
            // Never repeat an uncertain create as an automatic reconnect action.
            notice = document.createElement('div')
            notice.setAttribute('role', 'alert')
            notice.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:10001;background:#7f1d1d;color:white;padding:16px;border-radius:8px'
            notice.textContent = 'Remote workspace could not be opened: ' + String(error.message || error) + '. No local workspace was created; retry explicitly from Add workspace.'
            document.body.append(notice)
          }
        }
        inner.effect(() => { const dispose = workspaces.list.subscribe(open); open(); return () => { stopped = true; dispose(); notice?.remove() } }, 'remote-sessions.requested-workspace')
      })
    }
    return { name: 'ssh-remote-wrapper', apply }
  }
})
