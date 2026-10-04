    /* The slot is mounted inside a narrow sidebar header. Portal the dialog
     * to body: fixed positioning alone still inherits transformed ancestors. */
    function DirPicker({ open, busy, onPicked, onCancel }) {
      const [tab, setTab] = React.useState('local')
      const [localPath, setLocalPath] = React.useState('')
      const [machines, setMachines] = React.useState(null)
      const [machine, setMachine] = React.useState('')
      const [remotePath, setRemotePath] = React.useState('')
      const [pathDraft, setPathDraft] = React.useState('')
      const [entries, setEntries] = React.useState(null)
      const [error, setError] = React.useState('')
      const [pending, setPending] = React.useState(false)
      const [revision, setRevision] = React.useState(0)
      const dialogRef = React.useRef(null)
      const aliveRef = React.useRef(false)
      const pendingRef = React.useRef(false)
      const lockedRef = React.useRef(false)
      const cancelRef = React.useRef(onCancel)
      lockedRef.current = !!busy || pending
      cancelRef.current = onCancel
      const locked = !!busy || pending
      const close = () => { if (!lockedRef.current) cancelRef.current() }

      React.useEffect(() => {
        aliveRef.current = !!open
        if (!open) return
        const previousFocus = document.activeElement
        const dialog = dialogRef.current
        const focusable = () => Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'))
        ;(focusable()[0] || dialog).focus()
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation()
            if (!lockedRef.current) cancelRef.current()
          } else if (event.key === 'Tab') {
            const nodes = focusable()
            const first = nodes[0] || dialog
            const last = nodes[nodes.length - 1] || dialog
            if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
              event.preventDefault()
              ;(event.shiftKey ? last : first).focus()
            }
          }
        }
        const onFocus = (event) => {
          if (!lockedRef.current && !dialog.contains(event.target)) (focusable()[0] || dialog).focus()
        }
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('focusin', onFocus)
        return () => {
          aliveRef.current = false
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('focusin', onFocus)
          if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus()
        }
      }, [open])

      React.useEffect(() => {
        if (!open || tab !== 'remote') return
        const controller = new AbortController()
        setError('')
        api('GET', '/remote-sessions/machines', undefined, controller.signal).then((data) => {
          if (controller.signal.aborted) return
          const available = data.machines || []
          setMachines(available)
          if (!machine && available.length === 1) {
            setMachine(available[0].name)
            setRemotePath(available[0].remoteCwd || '~')
            setPathDraft(available[0].remoteCwd || '~')
          }
        }).catch((e) => { if (!controller.signal.aborted) setError(String(e.message || e)) })
        return () => controller.abort()
      }, [open, tab, revision])

      React.useEffect(() => {
        if (!open || tab !== 'remote' || !machine || !remotePath) return
        const controller = new AbortController()
        setEntries(null); setError('')
        api('GET', '/remote-sessions/ws-ls?machine=' + encodeURIComponent(machine) + '&path=' + encodeURIComponent(remotePath), undefined, controller.signal).then((data) => {
          if (controller.signal.aborted) return
          setPathDraft(data.path || remotePath)
          setEntries(data.entries || [])
        }).catch((e) => {
          if (!controller.signal.aborted) { setEntries([]); setError(String(e.message || e)) }
        })
        return () => controller.abort()
      }, [open, tab, machine, remotePath, revision])

      const adoptLocal = async (path) => {
        if (lockedRef.current || pendingRef.current || !path.trim()) return
        pendingRef.current = true; setPending(true); setError('')
        try { await onPicked(path.trim()) }
        catch (e) { if (aliveRef.current) setError(String(e.message || e)) }
        finally { pendingRef.current = false; if (aliveRef.current) setPending(false) }
      }
      const nativePick = async () => {
        if (lockedRef.current || pendingRef.current) return
        pendingRef.current = true; setPending(true); setError('')
        try {
          const data = await api('POST', '/remote-sessions/local-pick', {})
          if (aliveRef.current && data && typeof data.path === 'string' && data.path) await onPicked(data.path)
        } catch (e) { if (aliveRef.current) setError(String(e.message || e)) }
        finally { pendingRef.current = false; if (aliveRef.current) setPending(false) }
      }
      const navigate = (path) => { setRemotePath(path); setPathDraft(path) }
      const go = () => {
        const path = pathDraft.trim()
        if (path) { navigate(path); setRevision((n) => n + 1) }
      }
      const goUp = () => {
        const path = pathDraft.trim()
        if (!path.startsWith('/') || path === '/') return
        navigate(path.slice(0, path.replace(/\/$/, '').lastIndexOf('/')) || '/')
      }
      if (!open) return null
      const button = { ...BTN, color: 'inherit' }
      const row = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }
      const input = { ...INPUT, flex: '1 1 160px', width: 'auto', minWidth: 0 }
      const switchTab = (next) => { if (!locked) { setTab(next); setError('') } }
      return createPortal(React.createElement('div', {
        'data-remote-sessions-picker': 'modal-v1',
        style: { ...FONT, position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' },
        onClick: (event) => { event.stopPropagation(); if (event.target === event.currentTarget) close() },
        onKeyDown: (event) => event.stopPropagation()
      }, React.createElement('section', {
        ref: dialogRef, role: 'dialog', 'aria-modal': true, 'aria-label': 'Choose workspace', 'aria-busy': locked, tabIndex: -1,
        style: { width: 'min(600px, 100%)', maxHeight: 'calc(100dvh - 32px)', minWidth: 0, overflowY: 'auto', background: 'var(--dsw-alias-bg-layer-1, #18181b)', color: 'var(--dsw-alias-label-primary, #e4e4e7)', border: '1px solid var(--dsw-alias-border-l3, #52525b)', borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,.5)', padding: 16, boxSizing: 'border-box' }
      },
        React.createElement('div', { style: { ...row, justifyContent: 'space-between', marginBottom: 12 } },
          React.createElement('strong', { style: { fontSize: 16 } }, 'Choose workspace'),
          React.createElement('button', { type: 'button', style: button, disabled: locked, onClick: close }, 'Close')),
        React.createElement('div', { style: { ...row, marginBottom: 14 } },
          ['local', 'remote'].map((value) => React.createElement('button', { key: value, type: 'button', style: { ...button, fontWeight: tab === value ? 650 : 400 }, 'aria-pressed': tab === value, disabled: locked, onClick: () => switchTab(value) }, value === 'local' ? 'Local' : 'Remote machines'))),
        tab === 'local' ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          React.createElement('div', { style: row },
            React.createElement('button', { type: 'button', style: button, onClick: nativePick, disabled: locked }, pending ? 'Picking…' : 'Browse…'),
            React.createElement('input', { style: input, 'aria-label': 'Local directory', value: localPath, onChange: (e) => setLocalPath(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); adoptLocal(localPath) } }, placeholder: '/absolute/local/path', disabled: locked })),
          React.createElement('button', { type: 'button', style: { ...button, alignSelf: 'flex-start' }, disabled: locked || !localPath.trim(), onClick: () => adoptLocal(localPath) }, 'Use this local path'))
        : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
          React.createElement('div', { role: 'note', style: { lineHeight: 1.5 } }, 'Browse remote folders (read-only). Adding them to the local workspace/session tree is not implemented yet. No local placeholder will be created and the remote host will not be restarted.'),
          machines === null ? React.createElement('div', null, 'Loading machines…')
          : machines.length === 0 ? React.createElement('div', null, 'No remote machines configured (Settings → Remote Sessions).')
          : React.createElement(React.Fragment, null,
            React.createElement('div', { style: row },
              React.createElement('select', { 'aria-label': 'Remote machine', style: { ...input, flex: '0 1 160px' }, value: machine, disabled: locked, onChange: (e) => {
                const selected = machines.find((m) => m.name === e.target.value)
                setMachine(e.target.value); setEntries(null); navigate((selected && selected.remoteCwd) || '~')
              } }, React.createElement('option', { value: '' }, 'Choose machine'), machines.map((m) => React.createElement('option', { key: m.name, value: m.name }, m.name))),
              React.createElement('button', { type: 'button', style: button, onClick: goUp, disabled: locked || !machine || !pathDraft.startsWith('/') || pathDraft === '/' }, 'Up')),
            React.createElement('div', { style: row },
              React.createElement('input', { 'aria-label': 'Remote directory', style: input, value: pathDraft, disabled: locked || !machine, onChange: (e) => setPathDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }, placeholder: '/remote/path' }),
              React.createElement('button', { type: 'button', style: button, onClick: go, disabled: locked || !machine || !pathDraft.trim() }, 'Go')),
            machine ? React.createElement('div', { 'aria-label': 'Remote subdirectories', style: { maxHeight: 240, overflowY: 'auto', border: '1px solid rgba(127,127,127,.3)', borderRadius: 8, minHeight: 60 } },
              entries === null ? React.createElement('div', { style: { padding: 12 } }, 'Loading…')
              : entries.length === 0 ? React.createElement('div', { style: { padding: 12 } }, 'No subdirectories.')
              : entries.map((entry) => React.createElement('button', { key: entry.path, type: 'button', title: entry.path, disabled: locked, style: { ...button, display: 'block', width: '100%', textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRadius: 0 }, onClick: () => navigate(entry.path) }, '📁 ' + entry.name))) : null),
          React.createElement('button', { type: 'button', style: { ...button, alignSelf: 'flex-start' }, disabled: true, title: 'Requires real remote workspace and session routing' }, 'Add remote workspace — not available yet')),
        error ? React.createElement('div', { role: 'alert', style: { color: 'var(--dsw-static-red-400, #e06c75)', marginTop: 12, overflowWrap: 'anywhere' } }, error,
          tab === 'remote' ? React.createElement('button', { type: 'button', style: { ...button, marginLeft: 8 }, onClick: () => setRevision((n) => n + 1) }, 'Retry') : null) : null
      )), document.body)
    }

