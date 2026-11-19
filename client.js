/**
 * Dock Vitals (dsh-dock-insight) — a composer-dock readout for context occupancy, session
 * stats and token usage.
 *
 * Two slot entries share one module-level store:
 *  - `conversation.composer.dock` renders the compact readout (a proportional
 *    composition bar plus the occupancy percentage) and publishes the figures.
 *  - `shell.overlay` renders the click-open panel. It lives in the frame's
 *    floating layer because the docked composer clips its own overflow.
 *
 * All figures come from read-only projections; nothing is folded from session
 * events here. The two money cells read the signed-in account's wallets
 * through the Remote account service — no price table, so no invented rate.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dock-insight',
  factory(require) {
    const React = require('react')
    const { useEffect, useLayoutEffect, useRef, useState } = React
    const h = React.createElement

    const NS = 'dock-insight'
    const DOCK_SLOT = 'conversation.composer.dock'
    const OVERLAY_SLOT = 'shell.overlay'
    /** Wallet reads are Remote calls without a push channel; the dock polls one. */
    const ACCOUNT_POLL_MS = 60_000

    // ---------------------------------------------------------------- locale

    const DICT = {
      en: {
        'trigger.title': 'Dock Vitals',
        'trigger.running': 'Replying',
        'panel.title': 'Dock Vitals',
        'panel.contextUsed': 'Context used',
        'legend.system': 'System prompt',
        'legend.tools': 'Tool definitions',
        'legend.messages': 'Conversation',
        'section.stats': 'Session stats',
        'section.usage': 'Token usage',
        'stats.llm': 'Model time',
        'stats.tool': 'Tool time',
        'stats.ttft': 'Avg first token (TTFT)',
        'stats.tps': 'Output speed (TPS)',
        'stats.counts': 'Turns and steps',
        'stats.countsValue': '{turns} turns · {steps} steps',
        'usage.cacheHit': 'Cache hit',
        'usage.uncached': 'Uncached input',
        'usage.cacheRead': 'Cache read',
        'usage.output': 'Output',
        'usage.cacheWrite': 'Cache write',
        'usage.balance': 'Balance left',
        'usage.balanceHint': 'Recharge and bonus wallets of the signed-in account',
        'unit.tokens': '{value} tok',
        'unit.tps': '{tps} tok/s',
        'duration.seconds': '{seconds}s',
        'duration.minutes': '{minutes}m {seconds}s',
        'value.empty': '—',
      },
      zh: {
        'trigger.title': 'Dock Vitals',
        'trigger.running': '回复中',
        'panel.title': 'Dock Vitals',
        'panel.contextUsed': '上下文已用',
        'legend.system': '系统提示词',
        'legend.tools': '工具定义',
        'legend.messages': '对话消息',
        'section.stats': '会话统计',
        'section.usage': 'Token 用量',
        'stats.llm': '模型用时',
        'stats.tool': '工具调用用时',
        'stats.ttft': '首 token 平均（TTFT）',
        'stats.tps': '输出速度（TPS）',
        'stats.counts': '轮次与步数',
        'stats.countsValue': '{turns} 轮 · {steps} 步',
        'usage.cacheHit': '缓存命中',
        'usage.uncached': '未缓存输入',
        'usage.cacheRead': '缓存读取',
        'usage.output': '输出',
        'usage.cacheWrite': '缓存写入',
        'usage.balance': '剩余余额',
        'usage.balanceHint': '已登录账号的充值余额与赠金余额之和',
        'unit.tokens': '{value} tok',
        'unit.tps': '{tps} tok/s',
        'duration.seconds': '{seconds}秒',
        'duration.minutes': '{minutes}分{seconds}秒',
        'value.empty': '—',
      },
    }

    // ------------------------------------------------------------ formatting

    const round1 = (value) => Math.round(value * 10) / 10

    /** Compact token count for tight surfaces: 999, 7.4K, 234K, 1M. */
    function compactTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(round1(v)))
      if (value < 1_000) return String(Math.round(value))
      if (value < 1_000_000) return `${scaled(value / 1_000)}K`
      return `${scaled(value / 1_000_000)}M`
    }

    /** Exact token count with thousands separators: 675,218. */
    function exactTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /** Cache hit over every billed input token, as the stock usage dialog reads it. */
    function cacheHitPercent(usage) {
      if (usage === undefined) return null
      const total = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      if (!(total > 0)) return null
      return Math.round((usage.cacheReadTokens / total) * 100)
    }

    /** Elapsed milliseconds, rounded the way the stock stats dialog rounds them. */
    function formatDuration(ms, t) {
      if (!Number.isFinite(ms) || ms <= 0) return null
      const seconds = ms / 1_000
      if (seconds < 60) return t('duration.seconds', { seconds: String(round1(seconds)) })
      const whole = Math.round(seconds)
      return t('duration.minutes', {
        minutes: String(Math.floor(whole / 60)),
        seconds: String(whole % 60),
      })
    }

    /** Decode rate over generation time only, matching the stock TPS reading. */
    function formatTokensPerSecond(tps, t) {
      const clamped = Math.max(0, tps)
      const value = clamped >= 10 ? String(Math.round(clamped)) : String(round1(clamped))
      return t('unit.tps', { tps: value })
    }

    /**
     * Wall-clock since this reply started, in whole seconds so the ticker does
     * not wobble. Deliberately not the session's decode rate: that one is an
     * average over every turn, and printing it here would read as live speed.
     */
    function formatElapsed(ms, t) {
      const total = Math.max(0, Math.floor(ms / 1_000))
      if (total < 60) return t('duration.seconds', { seconds: String(total) })
      return t('duration.minutes', {
        minutes: String(Math.floor(total / 60)),
        seconds: String(total % 60),
      })
    }

    // ---------------------------------------------------------------- money

    /** Two decimals with grouped thousands; truncates rather than rounds. */
    function groupMoney(value) {
      const fixed = (Math.floor(Math.abs(value) * 100) / 100).toFixed(2)
      const [integer, fraction] = fixed.split('.')
      return `${Number(integer).toLocaleString()}.${fraction}`
    }

    /**
     * Wallet amount in the stock account settings' notation: sub-cent values
     * read `<¥0.01`, negatives keep their sign, everything else truncates to
     * two decimals. Kept in step with dsh-client-ui-settings-account.
     */
    function formatMoney(value, symbol) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null
      if (value === 0) return `${symbol}0.00`
      if (value < 0) {
        if (value > -0.01) return `-${symbol}0.01`
        return `-${symbol}${groupMoney(value)}`
      }
      if (value < 0.01) return `<${symbol}0.01`
      return `${symbol}${groupMoney(value)}`
    }

    /**
     * Client identity for one account read: the Host turns it into Platform
     * request headers. The boot graph carries the release version; a build
     * without one leaves the read out entirely instead of sending an empty one.
     */
    function clientMetadata(locale) {
      const boot = globalThis.__DSH_BOOT__
      const version = boot && boot.release && typeof boot.release.version === 'string'
        ? boot.release.version
        : null
      if (version === null || version === '') return null
      return {
        version,
        locale,
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
    }

    /**
     * The wallet sum for one currency: recharged and bonus wallets are both
     * spendable, so the readout adds them per currency and prefers CNY.
     */
    function walletsOf(reading) {
      if (reading === null) return null
      const wallets = [...reading.value, ...reading.bonusWallets]
      const usable = wallets.filter((wallet) => typeof wallet.balance === 'string')
      if (usable.length === 0) return null
      const currency = usable.some((wallet) => wallet.currency === 'CNY') ? 'CNY' : usable[0].currency
      let total = 0
      for (const wallet of usable) {
        if (wallet.currency !== currency) continue
        const amount = Number(wallet.balance)
        if (Number.isFinite(amount)) total += amount
      }
      return { currency, amount: total }
    }

    // ------------------------------------------------------------ view model

    const LEGEND = [
      { key: 'systemTokens', tint: 'system', labelKey: 'legend.system' },
      { key: 'toolsTokens', tint: 'tools', labelKey: 'legend.tools' },
      { key: 'messageTokens', tint: 'messages', labelKey: 'legend.messages' },
    ]

    function tintClass(tint) {
      if (tint === 'system') return 'dsdi-system'
      if (tint === 'tools') return 'dsdi-tools'
      if (tint === 'messages') return 'dsdi-messages'
      return ''
    }

    /**
     * Reduce the four projections to what the readout and panel paint. Every
     * field is null when its source is not ready, so a late projection shows a
     * placeholder instead of a wrong zero.
     */
    function buildView(sources, t) {
      const { pressure, breakdown, usage, sessionStats } = sources
      const usedTokens = pressure === undefined
        ? undefined
        : pressure.projectedTokens ?? pressure.pressureTokens
      const contextWindow = pressure === undefined ? undefined : pressure.contextWindow
      const occupancy = typeof usedTokens === 'number' && typeof contextWindow === 'number'
        && contextWindow > 0
        && Number.isFinite(usedTokens)
        ? {
            percent: Math.min(100, Math.round((usedTokens / contextWindow) * 100)),
            usedTokens,
            contextWindow,
          }
        : null

      // The bar is a composition bar, not an occupancy gauge: the three parts
      // are normalized to fill it, and the percentage above it already says how
      // full the window is. The dock glyph and the panel bar therefore carry the
      // same proportions at two sizes, and both stay readable at low occupancy.
      const breakdownTotal = breakdown === undefined
        ? 0
        : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
      const segments = breakdown === undefined || breakdownTotal <= 0
        ? []
        : LEGEND.map((row) => ({
            key: row.key,
            tint: row.tint,
            width: (breakdown[row.key] / breakdownTotal) * 100,
          })).filter((segment) => segment.width > 0)

      const legend = LEGEND.map((row) => ({
        key: row.key,
        tint: row.tint,
        label: t(row.labelKey),
        value: breakdown === undefined ? null : compactTokens(breakdown[row.key]),
      }))

      const llmMs = sessionStats === undefined ? 0 : sessionStats.llmMs
      const toolMs = sessionStats === undefined ? 0 : sessionStats.toolMs
      const ttftMs = sessionStats === undefined || sessionStats.ttftSteps === 0
        ? null
        : formatDuration(sessionStats.ttftMs / sessionStats.ttftSteps, t)
      const speed = sessionStats === undefined || sessionStats.decodeMs <= 0
        || sessionStats.decodeTokens <= 0
        ? null
        : formatTokensPerSecond(sessionStats.decodeTokens / (sessionStats.decodeMs / 1_000), t)

      const hitPercent = cacheHitPercent(usage)
      const tokens = (value) => t('unit.tokens', { value: exactTokens(value) })

      return {
        percent: occupancy === null ? null : `${occupancy.percent}%`,
        headline: t('panel.contextUsed'),
        figures: occupancy === null
          ? null
          : `~${compactTokens(occupancy.usedTokens)} / ${compactTokens(occupancy.contextWindow)}`,
        segments,
        legend,
        title: t('panel.title'),
        stats: [
          { key: 'llm', label: t('stats.llm'), value: formatDuration(llmMs, t) },
          { key: 'tool', label: t('stats.tool'), value: formatDuration(toolMs, t) },
          { key: 'ttft', label: t('stats.ttft'), value: ttftMs },
          { key: 'tps', label: t('stats.tps'), value: speed },
          {
            key: 'counts',
            label: t('stats.counts'),
            value: sessionStats === undefined
              ? null
              : t('stats.countsValue', { turns: sessionStats.turns, steps: sessionStats.steps }),
            wide: true,
          },
        ],
        usage: [
          {
            key: 'cacheHit',
            label: t('usage.cacheHit'),
            value: hitPercent === null ? null : `${hitPercent}%`,
          },
          {
            key: 'uncached',
            label: t('usage.uncached'),
            value: usage === undefined ? null : tokens(usage.uncachedInputTokens),
          },
          {
            key: 'cacheRead',
            label: t('usage.cacheRead'),
            value: usage === undefined ? null : tokens(usage.cacheReadTokens),
          },
          {
            key: 'output',
            label: t('usage.output'),
            value: usage === undefined ? null : tokens(usage.outputTokens),
          },
        ].concat(usage === undefined || usage.cacheWriteTokens === 0
          ? []
          : [{
            key: 'cacheWrite',
            label: t('usage.cacheWrite'),
            value: tokens(usage.cacheWriteTokens),
            wide: true,
          }]),
        sectionStats: t('section.stats'),
        sectionUsage: t('section.usage'),
        empty: t('value.empty'),
      }
    }

    /**
     * The wallet cell the panel appends after the token cells. Built at render
     * time from the store's latest wallet reading, so a reading that lands
     * after the dock last painted still shows on the next open.
     */
    function balanceCell(account, t) {
      const wallet = account === null || account === undefined ? null : account
      const symbol = wallet !== null && wallet.currency === 'USD' ? '$' : '¥'
      return {
        key: 'balance',
        label: t('usage.balance'),
        value: wallet === null ? null : formatMoney(wallet.amount, symbol),
        title: t('usage.balanceHint'),
        wide: true,
      }
    }

    /**
     * Reads the signed-in account's wallets for the dock. Every failure — no
     * account service, no boot version, denied call, signed out — answers null
     * and the cell falls back to the em dash instead of inventing a number.
     */
    function createAccountReader(ctx) {
      return {
        async read() {
          let account
          try {
            account = ctx.get('remote.account')
          } catch {
            return null
          }
          if (account === undefined || account === null || typeof account.getBalance !== 'function') {
            return null
          }
          const metadata = clientMetadata(ctx.locale.getSnapshot().active)
          if (metadata === null) return null
          let result
          try {
            result = await account.getBalance(metadata)
          } catch {
            return null
          }
          if (result === undefined || result === null || result.ok !== true) return null
          const detail = result.value
          if (detail === undefined || detail === null || detail.status !== 'ready') return null
          const wallet = walletsOf(detail)
          if (wallet === null) return null
          return { currency: wallet.currency, amount: wallet.amount }
        },
      }
    }

    // ------------------------------------------------------------- the store

    /**
     * The dock entry owns the figures and the open flag; the overlay entry
     * only paints them, so the panel survives the composer re-rendering and
     * never measures inside the composer's clipped box.
     */
    function createStore() {
      let state = { open: false, view: null, account: null }
      let anchor = null
      let runStartedAt = 0
      const listeners = new Set()
      const emit = () => {
        for (const listener of Array.from(listeners)) listener()
      }
      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        setView(view) {
          state = { open: state.open, view, account: state.account }
          emit()
        },
        setAccount(account) {
          state = { open: state.open, view: state.view, account }
          emit()
        },
        setOpen(open) {
          if (state.open === open) return
          state = { open, view: state.view, account: state.account }
          emit()
        },
        setAnchor(element) {
          anchor = element
        },
        markRunStart(now) {
          runStartedAt = now
        },
        runStart() {
          return runStartedAt
        },
        clearRunStart() {
          runStartedAt = 0
        },
        anchor() {
          return anchor
        },
        rect() {
          if (anchor === null || !anchor.isConnected) return null
          const box = anchor.getBoundingClientRect()
          if (box.width === 0 && box.height === 0) return null
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
        },
      }
    }

    const store = createStore()

    function useStored() {
      const [snapshot, setSnapshot] = useState(store.get())
      useEffect(() => {
        const sync = () => {
          setSnapshot(store.get())
        }
        return store.subscribe(sync)
      }, [])
      return snapshot
    }

    /** Locale-bound translate with a re-render on every locale switch. */
    function useTranslate(ctx) {
      const [, bump] = useState(0)
      useEffect(() => ctx.locale.subscribe(() => {
        bump((revision) => revision + 1)
      }), [ctx])
      return ctx.locale.bind(NS)
    }

    // ------------------------------------------------------------- components

    const CSS = `
.dsdi-root{display:inline-flex;flex:none}
.dsdi-trigger{display:inline-flex;align-items:center;gap:6px;flex:none;padding:1px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:var(--dsh-content-font-size-secondary,13px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer}
.dsdi-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.dsdi-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.dsdi-mini{display:flex;gap:1px;flex:none;width:26px;height:5px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dsdi-miniSeg{flex:none;height:100%;background:var(--dsdi-tint,var(--dsw-alias-label-tertiary))}
.dsdi-caret{flex:none;opacity:.7}
.dsdi-system{--dsdi-tint:var(--dsw-alias-chart-system)}
.dsdi-tools{--dsdi-tint:var(--dsw-alias-chart-tools)}
.dsdi-messages{--dsdi-tint:var(--dsw-alias-chart-messages)}
.dsdi-panel{position:fixed;z-index:1200;box-sizing:border-box;width:min(320px,calc(100vw - 24px));max-height:min(70vh,560px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--dsw-alias-border-l2) transparent;padding:12px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);pointer-events:auto;cursor:default}
.dsdi-panel::-webkit-scrollbar{width:8px}
.dsdi-panel::-webkit-scrollbar-track{background:transparent}
.dsdi-panel::-webkit-scrollbar-thumb{border:2px solid transparent;border-radius:999px;background:var(--dsw-alias-border-l2);background-clip:content-box}
[data-composer-dock]:has(.dsdi-root)>:not(:has(.dsdi-root)){display:none}
.dsdi-header{display:flex;align-items:center;gap:6px}
.dsdi-headline{color:var(--dsw-alias-label-tertiary)}
.dsdi-pulse{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary);animation:dsdi-pulse 1.4s ease-in-out infinite}
@keyframes dsdi-pulse{0%,100%{opacity:.3;transform:scale(.75)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion: reduce){.dsdi-pulse{animation:none;opacity:.85}}
.dsdi-elapsed{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dsdi-percent{font-weight:500;color:var(--dsw-alias-label-primary)}
.dsdi-figures{margin-left:auto;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsdi-bar{display:flex;gap:1px;margin:10px 0 12px;height:4px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
.dsdi-segment{flex:none;min-width:2px;height:100%;border-radius:1px;background:var(--dsdi-tint,var(--dsw-alias-label-tertiary))}
.dsdi-rows{margin:0}
.dsdi-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 0}
.dsdi-row dt{color:var(--dsw-alias-label-secondary)}
.dsdi-row dd{margin:0;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.dsdi-swatch{display:inline-block;margin-right:6px;width:8px;height:8px;border-radius:2px;background:var(--dsdi-tint)}
.dsdi-divider{height:1px;margin:10px -12px 0;background:var(--dsw-alias-border-l1)}
.dsdi-title{padding-top:10px;color:var(--dsw-alias-label-tertiary)}
.dsdi-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-top:6px}
.dsdi-cell{min-width:0}
.dsdi-cellWide{grid-column:1 / -1}
.dsdi-cellLabel{font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsdi-cellValue{margin-top:2px;font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

    /**
     * Hides the dock readings this panel replaces, for as long as it is mounted.
     *
     * One sweep at mount is not enough. The dock is rebuilt when the Session
     * changes, and the host mounts a reading only once it has data, so a pill
     * that appears a moment after us would sit visible beside our own trigger.
     * The sweep therefore repeats whenever the dock's child list changes, and
     * it re-attaches if React replaces the container underneath us.
     *
     * The walk goes up from our own anchor and hides, at every level, the
     * children that do not contain `.dsdi-root`; it stops at the dock container,
     * so composer chrome above it is never touched. Every hidden element gets
     * its original `display` back when we unmount.
     */
    function createDockIsolation(getRoot) {
      const hidden = new Map()
      let observer = null
      let observed = null
      let retryTimer = null
      let retries = 0

      const sweep = () => {
        const root = getRoot()
        if (root === null || root === undefined || root.parentElement === null) return null
        let node = root
        let container = null
        while (node.parentElement !== null) {
          const parent = node.parentElement
          for (const sibling of Array.from(parent.children)) {
            if (sibling === node) continue
            if (sibling.querySelector('.dsdi-root') !== null) continue
            if (!hidden.has(sibling)) hidden.set(sibling, sibling.style.display)
            if (sibling.style.display !== 'none') sibling.style.display = 'none'
          }
          if (parent.hasAttribute('data-composer-dock')) {
            container = parent
            break
          }
          node = parent
        }
        for (const element of Array.from(hidden.keys())) {
          if (element.isConnected === false) hidden.delete(element)
        }
        return container
      }

      const attach = () => {
        const container = sweep()
        if (container === null) {
          // The entry can be committed before the shell attaches it; retry a
          // few times rather than leave the dock uncovered.
          if (retryTimer === null && retries < 8) {
            retries += 1
            retryTimer = setTimeout(() => {
              retryTimer = null
              attach()
            }, 250)
          }
          return
        }
        if (container === observed && observer !== null) return
        if (observer !== null) observer.disconnect()
        observed = container
        if (typeof MutationObserver === 'function') {
          // childList only: the sweep writes `style.display`, and observing
          // attributes would make it feed its own callback. The container's
          // parent is watched too, because a shell rebuild replaces the dock
          // element itself and the old node then reports nothing.
          observer = new MutationObserver(() => attach())
          observer.observe(container, { childList: true, subtree: true })
          if (container.parentElement !== null) {
            observer.observe(container.parentElement, { childList: true, subtree: true })
          }
        }
      }

      return {
        start() {
          attach()
        },
        stop() {
          if (retryTimer !== null) clearTimeout(retryTimer)
          retryTimer = null
          if (observer !== null) observer.disconnect()
          observer = null
          observed = null
          for (const [element, display] of hidden) element.style.display = display
          hidden.clear()
        },
      }
    }

    function DockTrigger(props) {
      const t = useTranslate(props.ctx)
      const snapshot = useStored()
      const rootRef = useRef(null)
      const [, setTick] = useState(0)
      const statusHook = typeof props.useSessionStatus === 'function'
        ? props.useSessionStatus
        : (selector) => selector(new Map())
      const running = statusHook((statuses) => {
        const id = props.sessionId
        return id === undefined || id === null ? false : statuses.get(id)?.running === true
      }) === true
      const pressure = props.useProjection('contextPressure')
      const breakdown = props.useProjection('contextBreakdown')
      const usage = props.useProjection('tokenUsage')
      const sessionStats = props.useProjection('sessionStats')
      const view = buildView({
        pressure,
        breakdown,
        usage,
        sessionStats,
      }, t)

      useEffect(() => {
        store.setView(view)
      })

      // The wallet is a Remote read with no push channel of its own, so the
      // dock polls it while it is mounted and again whenever the panel opens.
      useEffect(() => {
        const sessionId = props.sessionId
        if (sessionId === undefined || sessionId === null) return undefined
        let cancelled = false
        const read = () => {
          Promise.resolve(props.reader.read(sessionId)).then((account) => {
            if (!cancelled) store.setAccount(account)
          }, () => {})
        }
        read()
        const timer = setInterval(read, ACCOUNT_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [props.reader, props.sessionId])

      useEffect(() => {
        if (!snapshot.open) return undefined
        const sessionId = props.sessionId
        if (sessionId === undefined || sessionId === null) return undefined
        Promise.resolve(props.reader.read(sessionId)).then((account) => {
          store.setAccount(account)
        }, () => {})
        return undefined
      }, [snapshot.open, props.reader, props.sessionId])

      // The reply indicator counts from the moment this dock first saw the
      // session running, so it measures the wait the user is actually in.
      useEffect(() => {
        if (!running) {
          store.clearRunStart()
          return undefined
        }
        if (store.runStart() === 0) store.markRunStart(Date.now())
        setTick((value) => value + 1)
        const timer = setInterval(() => setTick((value) => value + 1), 1_000)
        return () => clearInterval(timer)
      }, [running])

      useEffect(() => {
        store.setAnchor(rootRef.current)
        const isolation = createDockIsolation(() => rootRef.current)
        isolation.start()
        return () => {
          isolation.stop()
          store.setAnchor(null)
          store.setOpen(false)
        }
      }, [])

      const percent = view.percent === null ? view.empty : view.percent
      const startedAt = store.runStart()
      const elapsed = running && startedAt !== 0
        ? formatElapsed(Date.now() - startedAt, t)
        : null
      const label = running ? `${view.title} · ${t('trigger.running')}` : view.title

      return h(
        'span',
        { ref: rootRef, className: 'dsdi-root' },
        h('style', { key: 'css' }, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'dsdi-trigger',
            title: label,
            'aria-haspopup': 'dialog',
            'aria-expanded': snapshot.open,
            'aria-label': label,
            onClick: () => {
              store.setAnchor(rootRef.current)
              store.setOpen(!store.get().open)
            },
          },
          running
            ? h('span', { key: 'pulse', className: 'dsdi-pulse', 'aria-hidden': true })
            : null,
          elapsed === null
            ? null
            : h('span', { key: 'elapsed', className: 'dsdi-elapsed' }, elapsed),
          h(
            'span',
            { className: 'dsdi-mini', 'aria-hidden': true },
            view.segments.map((segment) => h('span', {
              key: segment.key,
              className: segment.tint === '' ? 'dsdi-miniSeg' : `dsdi-miniSeg ${tintClass(segment.tint)}`,
              style: { width: `${segment.width}%` },
            })),
          ),
          h('span', { key: 'text' }, percent),
          h(
            'svg',
            {
              key: 'caret',
              className: 'dsdi-caret',
              viewBox: '0 0 10 10',
              width: 10,
              height: 10,
              'aria-hidden': true,
            },
            h('path', {
              d: 'M2 4l3 3 3-3',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ),
        ),
      )
    }

    function InsightPanel(props) {
      const t = useTranslate(props.ctx)
      const snapshot = useStored()
      const panelRef = useRef(null)
      const [position, setPosition] = useState(null)
      const open = snapshot.open
      const view = snapshot.view
      const account = snapshot.account

      useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const rect = store.rect()
          const element = panelRef.current
          if (rect === null || element === null) return
          const width = window.innerWidth
          const height = window.innerHeight
          const boxWidth = element.offsetWidth
          const boxHeight = element.offsetHeight
          const left = Math.min(
            Math.max(12, rect.right - boxWidth),
            Math.max(12, width - boxWidth - 12),
          )
          const above = rect.top - boxHeight - 8
          const top = above >= 12
            ? above
            : Math.min(rect.bottom + 8, Math.max(12, height - boxHeight - 12))
          setPosition({ left, top })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, view])

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const panel = panelRef.current
          const anchor = store.anchor()
          if (panel !== null && panel.contains(event.target)) return
          if (anchor !== null && anchor.contains(event.target)) return
          store.setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') store.setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (!open || view === null) return null

      const value = (text) => text === null ? view.empty : text

      return h(
        'div',
        {
          ref: panelRef,
          className: 'dsdi-panel',
          role: 'dialog',
          'aria-label': view.title,
          style: position === null
            ? { left: 12, top: 12, opacity: 0 }
            : { left: position.left, top: position.top, opacity: 1 },
          // The panel scrolls itself; stop the wheel at its edge instead of
          // letting the frame treat it as a scroll of the chat behind.
          onWheel: (event) => { event.stopPropagation() },
        },
        h(
          'div',
          { className: 'dsdi-header', key: 'header' },
          h('span', { className: 'dsdi-headline' }, view.headline),
          h('span', { className: 'dsdi-percent' }, value(view.percent)),
          view.figures === null
            ? null
            : h('span', { className: 'dsdi-figures' }, view.figures),
        ),
        h(
          'div',
          { className: 'dsdi-bar', key: 'bar', 'aria-hidden': true },
          view.segments.map((segment) => h('div', {
            key: segment.key,
            className: segment.tint === '' ? 'dsdi-segment' : `dsdi-segment ${tintClass(segment.tint)}`,
            style: { width: `${segment.width}%` },
          })),
        ),
        h(
          'dl',
          { className: 'dsdi-rows', key: 'legend' },
          view.legend.map((row) => h(
            'div',
            { className: 'dsdi-row', key: row.key },
            h(
              'dt',
              null,
              h('span', { className: `dsdi-swatch ${tintClass(row.tint)}` }),
              row.label,
            ),
            h('dd', null, value(row.value)),
          )),
        ),
        h('div', { className: 'dsdi-divider', key: 'divider1', 'aria-hidden': true }),
        h('div', { className: 'dsdi-title', key: 'statsTitle' }, view.sectionStats),
        h(
          'div',
          { className: 'dsdi-grid', key: 'statsGrid' },
          view.stats.map((cell) => h(
            'div',
            {
              className: cell.wide === true ? 'dsdi-cell dsdi-cellWide' : 'dsdi-cell',
              key: cell.key,
            },
            h('div', { className: 'dsdi-cellLabel' }, cell.label),
            h('div', { className: 'dsdi-cellValue' }, value(cell.value)),
          )),
        ),
        h('div', { className: 'dsdi-divider', key: 'divider2', 'aria-hidden': true }),
        h('div', { className: 'dsdi-title', key: 'usageTitle' }, view.sectionUsage),
        h(
          'div',
          { className: 'dsdi-grid', key: 'usageGrid' },
          view.usage.concat(balanceCell(account, t)).map((cell) => h(
            'div',
            {
              className: cell.wide === true ? 'dsdi-cell dsdi-cellWide' : 'dsdi-cell',
              key: cell.key,
              title: cell.title,
            },
            h('div', { className: 'dsdi-cellLabel' }, cell.label),
            h('div', { className: 'dsdi-cellValue' }, value(cell.value)),
          )),
        ),
      )
    }

    // --------------------------------------------------------------- plugin

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The wallet reader resolves `remote.account` on every read, so the
        // plugin keeps working when the account package loads late or not at all.
        const reader = createAccountReader(ctx)
        ctx.effect(() => {
          const disposers = []
          for (const [locale, dict] of Object.entries(DICT)) {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict))
            } catch {
              // A previous instance of this plugin already owns the dictionary.
            }
          }
          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'dock-insight: dictionaries')

        ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
          name: DOCK_SLOT,
          id: 'dock-insight',
          order: 2,
        }, (props) => h(DockTrigger, { ...props, ctx, reader })))

        ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
          name: OVERLAY_SLOT,
          id: 'dock-insight-panel',
          order: 1200,
        }, () => h(InsightPanel, { ctx })))
      },
    }
  },
})
