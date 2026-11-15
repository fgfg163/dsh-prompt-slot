/**
 * Settings page for `@fgfg163/dsh-prompt-slot` — browser half.
 *
 * Bundle shape: this file is loaded by the client module system, so it must
 * register through `window.__ModuleLoader__.load` with a `factory(require)`
 * closure (same form the shipped `dsh-connect-workbuddy` bundle uses). Every
 * specifier required here is a module-table seed word or a package the graph
 * already carries, so no `dsh.client.external` declaration is needed.
 *
 * What the page edits: the two volatile fields of the Host plugin's `Config`
 * (`position`, `totalMaxChars`). Reads and writes go through
 * `ctx.configForms.get(ns)` — the client mirror of the Host `settings`
 * service, whose namespace is the profile entry id. One editing entry per
 * configuration: the page registers into `settings.section`, NOT into the
 * Plugins page's keyed config slots (the dsh-connect-workbuddy 5.19.0 rule).
 *
 * Styling follows the Harness settings rows: class names are prefixed `fgf-`
 * and only `--dsw-alias-*` tokens are referenced. The primitives package is
 * deliberately NOT required — it changes across releases and a throwing
 * component blanks the whole slot.
 *
 * The module id below must equal the package name: it is the graph
 * registration key.
 */
;(function (registration) {
  const Re = window.__ModuleLoader__
  const he = Re && Re[Symbol.for('@dsh-plugin/dsh-loader:load-wrap')]
  return (registration.id === '@fgfg163/dsh-prompt-slot' && Re.load === (he && he.ours) && typeof (he && he.original) === 'function'
    ? he.original
    : Re.load).call(Re, registration)
})({
  id: '@fgfg163/dsh-prompt-slot',
  factory: (require) => {
    const react = require('react')

    /** Settings namespace: the profile entry id this page edits. */
    const SETTINGS_NS = 'fgfg163-prompt-slot'

    /**
     * Candidate namespace spellings this page answers to.
     *
     * The Settings mirror keys a form by the Loader entry id. The Desktop host
     * mounts profile rows under the `include` tree, so the same row answers to
     * both the bare patch id and the `include:`-wrapped one depending on the
     * host build. Ask the mirror which spelling it serves instead of
     * hard-coding one (dsh-connect-workbuddy hit the same divergence).
     */
    const SETTINGS_NS_CANDIDATES = ['include:' + SETTINGS_NS, SETTINGS_NS]

    /** Stylesheet id; also the duplicate-insert guard. */
    const STYLE_ID = '@fgfg163/dsh-prompt-slot/settings.css'

    /** Row/control styles copied from the Harness settings sections. */
    const CSS = `
.fgf-section{box-sizing:border-box;display:flex;flex-direction:column;max-width:720px;width:100%;color:var(--dsw-alias-label-primary)}
.fgf-intro{margin:0 0 4px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.fgf-row{display:flex;align-items:center;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.fgf-row:last-of-type{border-bottom:none}
.fgf-row-text{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.fgf-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.fgf-desc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.fgf-control{display:flex;align-items:center;gap:8px;flex:none}
.fgf-input,.fgf-select{box-sizing:border-box;height:36px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;padding:0 12px;min-width:0}
.fgf-input:focus,.fgf-select:focus{outline:none;border-color:var(--dsw-alias-border-selected)}
.fgf-input:disabled,.fgf-select:disabled{opacity:.5;cursor:not-allowed}
.fgf-select{cursor:pointer;padding-right:8px}
.fgf-actions{display:flex;align-items:center;gap:8px;padding:20px 0 8px}
.fgf-button{box-sizing:border-box;height:32px;padding:0 14px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.fgf-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.fgf-button:disabled{opacity:.5;cursor:not-allowed}
.fgf-button-primary{border-color:transparent;background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);color:#fff}
.fgf-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.fgf-notice{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
`

    const zh = {
      nav: '提示注入槽',
      intro: '每轮注入块的预算与摆放。改动即时生效，不重启插件。',
      positionTitle: '注入位置',
      positionDescription: 'before 紧贴本轮用户提问之前；after 追加在所有注入之后（与 time-context、agentmemory 一致）。',
      totalTitle: '单轮总预算',
      totalDescription: '一轮里所有槽位拼接后的总字符上限。',
      loading: '正在连接配置服务…',
      unavailable: '配置服务不可用（插件未激活，或当前组合不是 profile）。',
      readOnly: '当前组合对该配置只读（home 层或命令行覆盖优先）。',
      saveFailed: '保存失败：',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
    }

    /** Draft snapshot this component stages until 保存. */
    const usePromptSlotForm = (scope) => {
      const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot())
      react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])
      return snapshot
    }

    /** One settings row: title + description on the left, control on the right. */
    const Row = ({ id, title, description, children }) =>
      react.createElement(
        'div',
        { className: 'fgf-row' },
        react.createElement(
          'div',
          { className: 'fgf-row-text' },
          react.createElement('label', { htmlFor: id, className: 'fgf-title' }, title),
          react.createElement('p', { className: 'fgf-desc' }, description),
        ),
        react.createElement('div', { className: 'fgf-control' }, children),
      )

    /** The section page body for one bound settings scope. */
    const PromptSlotPage = ({ scope, labels }) => {
      const snapshot = usePromptSlotForm(scope)
      const [draft, setDraft] = react.useState(null)
      const [saving, setSaving] = react.useState(false)
      const [error, setError] = react.useState(undefined)

      if (snapshot.status === 'loading' || snapshot.value === undefined) {
        return react.createElement('p', { className: 'fgf-notice' }, labels.loading)
      }
      const writable = snapshot.writable === true
      const value = snapshot.value
      const draftValue = draft ?? {
        position: value.position === 'after' ? 'after' : 'before',
        totalMaxChars: typeof value.totalMaxChars === 'number' ? value.totalMaxChars : 8000,
      }
      const accepted = {
        position: value.position === 'after' ? 'after' : 'before',
        totalMaxChars: typeof value.totalMaxChars === 'number' ? value.totalMaxChars : 8000,
      }
      const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(accepted)

      const save = async () => {
        if (!writable || draft === null) return
        setSaving(true)
        setError(undefined)
        try {
          const okPosition = await scope.set('position', draftValue.position)
          const okTotal = okPosition ? await scope.set('totalMaxChars', draftValue.totalMaxChars) : false
          if (!okPosition || !okTotal) setError(labels.saveFailed + 'host refused the write')
          setDraft(null)
        } catch (cause) {
          setError(labels.saveFailed + (cause instanceof Error ? cause.message : String(cause)))
        } finally {
          setSaving(false)
        }
      }

      const disabled = !writable || saving
      return react.createElement(
        'div',
        { className: 'fgf-section' },
        react.createElement('p', { className: 'fgf-intro' }, labels.intro),
        !writable && snapshot.revision !== undefined
          ? react.createElement('p', { className: 'fgf-notice' }, labels.readOnly)
          : null,
        react.createElement(Row, {
          id: 'fgfg163-prompt-slot-position',
          title: labels.positionTitle,
          description: labels.positionDescription,
        },
        react.createElement(
          'select',
          {
            id: 'fgfg163-prompt-slot-position',
            className: 'fgf-select',
            value: draftValue.position,
            disabled,
            onChange: (event) => setDraft({ ...draftValue, position: event.target.value }),
          },
          react.createElement('option', { value: 'before' }, 'before'),
          react.createElement('option', { value: 'after' }, 'after'),
        )),
        react.createElement(Row, {
          id: 'fgfg163-prompt-slot-total',
          title: labels.totalTitle,
          description: labels.totalDescription,
        },
        react.createElement('input', {
          id: 'fgfg163-prompt-slot-total',
          type: 'number',
          className: 'fgf-input',
          style: { width: 140 },
          min: 1,
          step: 1,
          value: draftValue.totalMaxChars,
          disabled,
          onChange: (event) => {
            const next = Number(event.target.value)
            if (Number.isSafeInteger(next) && next > 0) setDraft({ ...draftValue, totalMaxChars: next })
          },
        })),
        react.createElement(
          'div',
          { className: 'fgf-actions' },
          react.createElement(
            'button',
            {
              type: 'button',
              className: 'fgf-button fgf-button-primary',
              disabled: !dirty || disabled,
              onClick: () => { void save() },
            },
            saving ? labels.saving : labels.save,
          ),
          dirty && !saving
            ? react.createElement(
                'button',
                { type: 'button', className: 'fgf-button', onClick: () => setDraft(null) },
                labels.discard,
              )
            : null,
          error !== undefined
            ? react.createElement('span', { className: 'fgf-error' }, error)
            : null,
        ),
      )
    }

    /** Mount the stylesheet once per page; remove it when this fiber unloads. */
    const useStyles = (ctx) => {
      ctx.effect(() => {
        const selector = `style[data-plugin-css="${STYLE_ID}"]`
        if (document.querySelector(selector) === null) {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@fgfg163/dsh-prompt-slot'
          tag.dataset.pluginCss = STYLE_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
        }
        return () => {
          const tag = document.querySelector(selector)
          if (tag !== null) tag.remove()
        }
      }, 'prompt-slot settings: styles')
    }

    return {
      /**
       * `slots` MUST be declared: the Client hands this module a guarded
       * context, and reading `ctx.slots` without a declaration throws
       * "cannot get property \"slots\" without inject".
       *
       * `configForms` is deliberately NOT declared. It is registered by
       * ui-settings after its remote connection is ready, so a hard injection
       * would park this whole module until then (and forever if the service
       * never appears). `ctx.get()` needs no declaration, so apply polls it.
       */
      inject: ['slots'],
      /**
       * Cordis client apply: register the Settings section.
       *
       * `configForms` may be absent for a while after this module applies, so
       * poll for it; once it exists, `whileServed` watches every candidate
       * namespace spelling and re-runs when the mirror populates.
       */
      apply(ctx) {
        useStyles(ctx)
        let bound = false
        let pollTimer
        let waitedMs = 0
        const formsNow = () => ctx.get('configForms')
        const servedNamespaces = (forms) => {
          if (typeof forms.describe !== 'function') return []
          const view = forms.describe().getSnapshot()?.view
          return (view?.namespaces ?? []).map((row) => row.ns)
        }
        const bind = () => {
          if (bound) return
          const forms = formsNow()
          if (forms === undefined) return
          const served = new Set(servedNamespaces(forms))
          const ns = SETTINGS_NS_CANDIDATES.find((candidate) => served.has(candidate)) ?? SETTINGS_NS
          const scope = typeof forms.get === 'function' ? forms.get(ns) : undefined
          if (scope === undefined) return
          bound = true
          const labels = zh
          const page = (props) =>
            react.createElement(PromptSlotPage, {
              scope,
              labels,
              ...props,
            })
          ctx.effect(() => {
            const injectSection = ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: ns,
                  order: 40,
                  label: () => zh.nav,
                },
                page,
              ),
            )
            return () => {
              if (typeof injectSection === 'function') injectSection()
            }
          }, 'prompt-slot settings: section')
        }
        const attach = () => {
          if (bound) return
          const forms = formsNow()
          if (forms === undefined) {
            if (waitedMs >= 15000) {
              console.error('prompt-slot settings: ctx.configForms never appeared, settings section stays unregistered')
              return
            }
            waitedMs += 250
            pollTimer = setTimeout(attach, 250)
            return
          }
          if (typeof forms.whileServed === 'function') {
            ctx.effect(
              () => forms.whileServed(SETTINGS_NS_CANDIDATES, () => bind()),
              'prompt-slot settings: late binding',
            )
          } else {
            bind()
          }
          // A served mirror can lag the service: retry once shortly after.
          setTimeout(bind, 1000)
        }
        ctx.effect(() => {
          attach()
          return () => {
            if (pollTimer !== undefined) clearTimeout(pollTimer)
          }
        }, 'prompt-slot settings: bind')
      },
    }
  },
})
