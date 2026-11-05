import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const API = '/api/procurement'

function money(minor) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format((Number(minor) || 0) / 100)
}

function dateLabel(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function formatRequestError(error) {
  const differences = error.responseData?.differences
  return Array.isArray(differences) && differences.length
    ? `${error.message}\n${differences.map((difference) => `• ${difference}`).join('\n')}`
    : error.message
}

function makeIdempotencyKey() {
  if (!window.crypto?.randomUUID) throw new Error('Secure browser randomness is required to start checkout.')
  return window.crypto.randomUUID()
}

function PayPalButtons({ clientId, projectId, approval, existingAttempt, api, onMessage, onRefresh }) {
  const hostRef = useRef(null)
  const attemptRef = useRef(existingAttempt || null)

  useEffect(() => {
    let active = true
    const host = hostRef.current
    if (!host || !clientId) return undefined

    const scriptUrl = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`
    let script = document.querySelector('script[data-trustgate-paypal="true"]')
    if (script && script.src !== scriptUrl && !window.paypal) {
      script.remove()
      script = null
    }

    const loadSdk = () => new Promise((resolve, reject) => {
      if (window.paypal?.Buttons) return resolve()
      const current = script || document.createElement('script')
      if (!script) {
        current.src = scriptUrl
        current.async = true
        current.dataset.trustgatePaypal = 'true'
        script = current
      }
      current.addEventListener('load', resolve, { once: true })
      current.addEventListener('error', () => reject(new Error('Could not load the official PayPal Sandbox JavaScript SDK.')), { once: true })
      if (!current.isConnected) document.head.appendChild(current)
    })

    loadSdk()
      .then(() => {
        if (!active || !window.paypal?.Buttons) return
        host.replaceChildren()
        return window.paypal.Buttons({
          style: { layout: 'vertical', shape: 'rect', label: 'pay', tagline: false },
          createOrder: async () => {
            const currentAttempt = attemptRef.current
            const idempotencyKey = currentAttempt?.clientIdempotencyKey || makeIdempotencyKey()
            try {
              const result = await api(`/projects/${projectId}/checkout`, {
                method: 'POST',
                headers: { 'Idempotency-Key': idempotencyKey },
                body: JSON.stringify({ approvalId: approval._id, idempotencyKey }),
              })
              attemptRef.current = result.attempt
              if (!result.orderId) throw new Error('The server did not return a PayPal order ID.')
              return result.orderId
            } catch (error) {
              if (error.responseData?.attempt) attemptRef.current = error.responseData.attempt
              onMessage(formatRequestError(error))
              await onRefresh()
              throw error
            }
          },
          onApprove: async () => {
            const attempt = attemptRef.current
            if (!attempt?._id) throw new Error('Checkout attempt is missing; refresh the project and retry.')
            const result = await api(`/projects/${projectId}/checkout/${attempt._id}/capture`, { method: 'POST' })
            onMessage(result.completed ? 'PayPal confirmed payment. The reserved stock is now committed.' : 'Capture submitted; check checkout status.')
            await onRefresh()
          },
          onCancel: async () => {
            const attempt = attemptRef.current
            if (attempt?._id) {
              try {
                await api(`/projects/${projectId}/checkout/${attempt._id}/cancel`, { method: 'POST' })
              } catch (error) {
                onMessage(error.message)
              }
            }
            await onRefresh()
          },
          onError: async (error) => {
            onMessage(formatRequestError(error || new Error('PayPal Checkout reported an error.')))
            await onRefresh()
          },
        }).render(host)
      })
      .catch((error) => onMessage(error.message))

    return () => {
      active = false
      host?.replaceChildren()
    }
  }, [clientId, projectId, approval, api, onMessage, onRefresh])

  return <div className="paypal-button-host" ref={hostRef} />
}

function ClarificationPanel({ project, onSubmit, busy }) {
  const [values, setValues] = useState(() => project.clarificationQuestions?.map((question) => question.answer || '') || [])
  const [confirmAssumptions, setConfirmAssumptions] = useState(Boolean(project.assumptionsConfirmedAt))
  const questions = project.clarificationQuestions || []

  const pending = questions.some((question, index) => question.critical && !values[index]?.trim())
  const missingBudget = project.budgetMinor <= 0
  const budgetQuestion = questions.findIndex((question) => /budget/i.test(question.question))
  const needsBudgetAnswer = missingBudget && budgetQuestion < 0 && !values.budgetUsd

  return (
    <section className="proc-card procurement-clarifications">
      <header className="proc-card-heading">
        <div><p className="eyebrow">01 · Clarify</p><h2>Confirm the important details</h2></div>
        <span className={`status-chip ${pending || missingBudget ? 'attention' : 'good'}`}>
          {pending || missingBudget ? 'Needs your input' : 'Ready to plan'}
        </span>
      </header>
      <p className="proc-muted">The AI asks when a missing detail could materially change the basket. No laptop-per-attendee assumption is made.</p>
      {questions.map((question, index) => (
        <label className="proc-field" key={`${question.question}-${index}`}>
          <span>{question.question}{question.critical && <b> · required</b>}</span>
          <input
            className="proc-input"
            value={values[index] || ''}
            onChange={(event) => setValues((current) => {
              const next = [...current]
              next[index] = event.target.value
              if (/budget/i.test(question.question)) next.budgetUsd = event.target.value
              return next
            })}
            placeholder={/budget/i.test(question.question) ? 'e.g. 600.00' : /quantity|how many/i.test(question.question) ? 'Enter a whole number' : 'Your answer'}
            required={question.critical}
          />
        </label>
      ))}
      {((missingBudget && budgetQuestion < 0) || project.beneficiaryCount < 1) && (
        <div className="proc-inline-fields">
          {missingBudget && budgetQuestion < 0 && (
            <label className="proc-field">
              <span>Total budget (USD)</span>
              <input className="proc-input" inputMode="decimal" value={values.budgetUsd || ''} onChange={(event) => setValues((current) => ({ ...current, budgetUsd: event.target.value }))} placeholder="600.00" />
            </label>
          )}
          {project.beneficiaryCount < 1 && (
            <label className="proc-field">
              <span>Beneficiary count</span>
              <input className="proc-input" type="number" min="1" step="1" value={values.beneficiaryCount || ''} onChange={(event) => setValues((current) => ({ ...current, beneficiaryCount: event.target.value }))} />
            </label>
          )}
        </div>
      )}
      <div className="assumptions-box">
        <strong>Store and delivery assumptions</strong>
        <ul>
          {(project.structuredRequirements?.deliveryAssumptions || []).map((assumption) => <li key={assumption}>{assumption}</li>)}
          <li>{'Fixed $12 demo shipping fee; $0 demo tax. Not real-world tax or carrier pricing.'}</li>
        </ul>
        <label className="proc-check">
          <input type="checkbox" checked={confirmAssumptions} onChange={(event) => setConfirmAssumptions(event.target.checked)} />
          <span>I have reviewed these assumptions and understand delivery timing is not confirmed.</span>
        </label>
      </div>
      <button
        className="proc-button secondary"
        disabled={busy || (pending && !questions.every((question, index) => !question.critical || values[index]?.trim())) || needsBudgetAnswer}
        onClick={() => onSubmit({
          answers: questions.map((question, index) => ({ index, value: values[index] || '' })),
          budgetUsd: values.budgetUsd || (budgetQuestion >= 0 ? values[budgetQuestion] : undefined),
          beneficiaryCount: values.beneficiaryCount || undefined,
          confirmAssumptions,
        })}
      >
        {busy ? 'Saving…' : confirmAssumptions ? 'Save answers & confirm assumptions' : 'Save clarification answers'}
      </button>
      {!confirmAssumptions && <p className="proc-hint">You can clarify now; final approval stays disabled until assumptions are confirmed.</p>}
    </section>
  )
}

function BasketEditor({ catalog, requirements, initialItems, onSave, onCancel, busy, title }) {
  const [items, setItems] = useState(initialItems?.length
    ? initialItems.map((item) => ({ sku: item.sku, quantity: String(item.quantity) }))
    : [{ sku: catalog[0]?.sku || '', quantity: '1' }])

  const save = (event) => {
    event.preventDefault()
    const cleanItems = items.map((item) => ({ sku: item.sku, quantity: Number(item.quantity) }))
    onSave(cleanItems, [])
  }

  return (
    <form className="proc-card basket-editor" onSubmit={save}>
      <header className="proc-card-heading"><div><p className="eyebrow">Basket editor</p><h2>{title}</h2></div></header>
      <p className="proc-muted">Choose products and quantities. TrustGate matches required items to your selected products automatically, then checks the basket and calculates the total.</p>
      <div className="basket-line-list">
        {items.map((item, index) => (
          <div className="basket-edit-line" key={`basket-${index}`}>
            <select className="proc-input" value={item.sku} onChange={(event) => setItems((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, sku: event.target.value } : line))} required aria-label={`Product line ${index + 1}`}>
              {catalog.map((product) => <option key={product.sku} value={product.sku}>{product.name} · {money(product.unitPriceMinor)} · {product.availableStock} available</option>)}
            </select>
            <input className="proc-input quantity-input" type="number" min="1" step="1" value={item.quantity} onChange={(event) => setItems((current) => current.map((line, lineIndex) => lineIndex === index ? { ...line, quantity: event.target.value } : line))} required aria-label={`Quantity for line ${index + 1}`} />
            <button type="button" className="proc-icon-button" onClick={() => setItems((current) => current.filter((_, lineIndex) => lineIndex !== index))} disabled={items.length === 1} aria-label={`Remove line ${index + 1}`}>×</button>
          </div>
        ))}
      </div>
      <button type="button" className="proc-button secondary" onClick={() => setItems((current) => [...current, { sku: catalog[0]?.sku || '', quantity: '1' }])} disabled={!catalog.length}>Add product</button>
      {requirements.some((requirement) => requirement.required) && (
        <div className="requirement-map-editor">
          <strong>Must include</strong>
          <ul>{requirements.filter((requirement) => requirement.required).map((requirement) => (
            <li key={requirement.key}>{requirement.description}</li>
          ))}</ul>
        </div>
      )}
      <footer className="proc-actions">
        <button type="button" className="proc-button secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="proc-button primary" disabled={busy || !catalog.length}>{busy ? 'Validating…' : 'Save as new version'}</button>
      </footer>
    </form>
  )
}

export default function ProcurementApp() {
  const [page, setPage] = useState('workspace')
  const [catalog, setCatalog] = useState([])
  const [merchant, setMerchant] = useState(null)
  const [paypal, setPaypal] = useState(null)
  const [projects, setProjects] = useState([])
  const [projectDetail, setProjectDetail] = useState(null)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [goal, setGoal] = useState('')
  const [projectTitle, setProjectTitle] = useState('')
  const [beneficiaryCount, setBeneficiaryCount] = useState('')
  const [budgetUsd, setBudgetUsd] = useState('')
  const [contingencyUsd, setContingencyUsd] = useState('')
  const [basketEditor, setBasketEditor] = useState(null)
  const [clarificationBusy, setClarificationBusy] = useState(false)
  const noticeTimer = useRef(null)

  const api = useCallback(async (path, options = {}) => {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const requestError = new Error(data?.error || `Request failed (${response.status} ${response.statusText})`)
      requestError.responseData = data
      requestError.status = response.status
      throw requestError
    }
    if (data === null) throw new Error('The server returned an invalid response. Confirm the local API server is running.')
    return data
  }, [])

  const notify = useCallback((message) => {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6500)
  }, [])

  const loadWorkspace = useCallback(async () => {
    const [storefront, listedProjects] = await Promise.all([
      api('/storefront'),
      api('/projects'),
    ])
    setCatalog(storefront.products || [])
    setMerchant(storefront.merchant)
    setPaypal(storefront.paypal)
    setProjects(listedProjects)
  }, [api])

  const loadProject = useCallback(async (projectId = selectedProjectId) => {
    if (!projectId) {
      setProjectDetail(null)
      return
    }
    const detail = await api(`/projects/${projectId}`)
    setProjectDetail(detail)
    setSelectedPlanId((current) => (
      detail.plans.some((plan) => plan._id === current)
        ? current
        : detail.plans[0]?._id || ''
    ))
  }, [api, selectedProjectId])

  const refresh = useCallback(async () => {
    await loadWorkspace()
    if (selectedProjectId) await loadProject(selectedProjectId)
  }, [loadWorkspace, loadProject, selectedProjectId])

  useEffect(() => {
    let active = true
    Promise.all([api('/storefront'), api('/projects')])
      .then(([storefront, listedProjects]) => {
        if (!active) return
        setCatalog(storefront.products || [])
        setMerchant(storefront.merchant)
        setPaypal(storefront.paypal)
        setProjects(listedProjects)
        setLoading(false)
      })
      .catch((requestError) => {
        if (!active) return
        setError(formatRequestError(requestError))
        setLoading(false)
      })
    return () => { active = false }
  }, [api])

  useEffect(() => {
    let active = true
    if (!selectedProjectId) {
      setProjectDetail(null)
      return undefined
    }
    api(`/projects/${selectedProjectId}`)
      .then((detail) => { if (active) setProjectDetail(detail) })
      .catch((requestError) => { if (active) setError(requestError.message) })
    return () => { active = false }
  }, [selectedProjectId, api])

  const project = projectDetail?.project
  const plans = projectDetail?.plans || []
  const selectedPlan = plans.find((plan) => plan._id === selectedPlanId) || plans[0] || null
  const activeApproval = useMemo(() => {
    if (!selectedPlan || !projectDetail) return null
    return projectDetail.approvals?.find((approval) => (
      approval.planId === selectedPlan._id
      && !approval.invalidatedAt
      && new Date(approval.expiresAt).getTime() > Date.now()
    )) || null
  }, [selectedPlan, projectDetail])
  const selectedPlanApproval = selectedPlan && projectDetail
    ? projectDetail.approvals?.find((approval) => approval.planId === selectedPlan._id && !approval.invalidatedAt) || null
    : null
  const currentAttempt = selectedPlanApproval
    ? projectDetail?.checkoutAttempts?.find((attempt) => attempt.approvalId === selectedPlanApproval._id && attempt.executionState !== 'FAILED' && attempt.executionState !== 'CANCELLED')
    : null
  const approvalForDisplay = activeApproval || (currentAttempt ? selectedPlanApproval : null)
  const requirements = [
    ...(project?.structuredRequirements?.requiredItems || []).map((item) => ({ ...item, required: true })),
    ...(project?.structuredRequirements?.optionalItems || []).map((item) => ({ ...item, required: false })),
  ]

  const createProject = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await api('/projects', {
        method: 'POST',
        body: JSON.stringify({
          title: projectTitle,
          originalGoal: goal,
          beneficiaryCount: beneficiaryCount || undefined,
          budgetUsd: budgetUsd || undefined,
          contingencyUsd: contingencyUsd || undefined,
          currency: 'USD',
        }),
      })
      await loadWorkspace()
      setSelectedProjectId(result.project._id)
      setSelectedPlanId('')
      setPage('review')
      setGoal('')
      setProjectTitle('')
      if (result.extractionError) {
        notify(`Project saved, but AI extraction needs retry: ${result.extractionError}`)
      } else {
        notify('Project saved. Review clarifications before generating a basket.')
      }
    } catch (requestError) {
      setError(formatRequestError(requestError))
    } finally {
      setBusy(false)
    }
  }

  const retryExtraction = async () => {
    if (!project) return
    setBusy(true)
    try {
      const result = await api(`/projects/${project._id}/extract`, { method: 'POST' })
      await refresh()
      notify(result.extractionError || 'Requirements extracted. Review all questions before planning.')
    } catch (requestError) {
      setError(formatRequestError(requestError))
    } finally {
      setBusy(false)
    }
  }

  const saveClarifications = async (payload) => {
    if (!project) return
    setClarificationBusy(true)
    try {
      await api(`/projects/${project._id}/clarifications`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      await refresh()
      notify('Clarification answers and assumption confirmation saved.')
    } catch (requestError) {
      setError(formatRequestError(requestError))
    } finally {
      setClarificationBusy(false)
    }
  }

  const generatePlans = async () => {
    if (!project) return
    setBusy(true)
    setError('')
    try {
      const result = await api(`/projects/${project._id}/plans`, { method: 'POST', body: JSON.stringify({}) })
      await refresh()
      if (result.plans.length) setSelectedPlanId(result.plans[0]._id)
      notify(`AI proposed ${result.plans.length} distinct validated basket${result.plans.length === 1 ? '' : 's'}. Review before approval.`)
    } catch (requestError) {
      setError(formatRequestError(requestError))
    } finally {
      setBusy(false)
    }
  }

  const saveBasket = async (items) => {
    if (!project || !basketEditor) return
    setBusy(true)
    try {
      const url = basketEditor.planId
        ? `/projects/${project._id}/plans/${basketEditor.planId}`
        : `/projects/${project._id}/plans/manual`
      const result = await api(url, {
        method: basketEditor.planId ? 'PUT' : 'POST',
        body: JSON.stringify({ items }),
      })
      setBasketEditor(null)
      await refresh()
      setSelectedPlanId(result._id)
      notify(result.validationReport.valid ? `Saved plan version ${result.version}; deterministic checks passed.` : `Saved plan version ${result.version} as a draft. Review blocking validation issues.`)
    } catch (requestError) {
      setError(formatRequestError(requestError))
    } finally {
      setBusy(false)
    }
  }

  const approvePlan = async (plan) => {
    if (!project || !plan) return
    setBusy(true)
    try {
      const result = await api(`/projects/${project._id}/plans/${plan._id}/approve`, { method: 'POST' })
      await refresh()
      setSelectedPlanId(plan._id)
      notify(`Approved exact plan version ${result.approval.planVersion} at ${money(result.approval.approvedTotalMinor)}. Approval expires ${dateLabel(result.approval.expiresAt)}.`)
    } catch (requestError) {
      setError(formatRequestError(requestError))
    } finally {
      setBusy(false)
    }
  }

  const messageFromPaypal = useCallback((message) => {
    if (message) notify(message)
  }, [notify])

  const refreshFromPaypal = useCallback(async () => {
    await refresh()
  }, [refresh])

  const chooseProject = (projectId) => {
    setSelectedProjectId(projectId)
    setSelectedPlanId('')
    setBasketEditor(null)
    setPage('review')
  }

  return (
    <div className="proc-app">
      {notice && <div className="proc-toast" role="status">{notice}</div>}
      <header className="proc-header">
        <a className="proc-brand" href="#workspace" onClick={(event) => { event.preventDefault(); setPage('workspace') }}>
          <span className="proc-brand-mark">T</span>
          <span>TrustGate <small>PROCUREMENT</small></span>
        </a>
        <nav className="proc-nav" aria-label="Main navigation">
          <button className={page === 'workspace' ? 'active' : ''} onClick={() => setPage('workspace')}>Workspace</button>
          <button className={page === 'review' ? 'active' : ''} onClick={() => setPage('review')} disabled={!selectedProjectId}>Review AI plan</button>
          <button className={page === 'catalog' ? 'active' : ''} onClick={() => setPage('catalog')}>Demo catalog</button>
          <button className={page === 'guide' ? 'active' : ''} onClick={() => setPage('guide')}>Guide</button>
        </nav>
        <span className="proc-local-badge">Local-only · USD</span>
      </header>

      <main className="proc-main">
        {error && <div className="proc-alert error" role="alert"><strong>Action needs attention</strong><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {loading ? (
          <div className="proc-empty"><p>Loading TrustGate Procurement…</p></div>
        ) : page === 'guide' ? (
          <GuidePage onOpenWorkspace={() => setPage('workspace')} />
        ) : page === 'catalog' ? (
          <CatalogPage merchant={merchant} catalog={catalog} />
        ) : page === 'workspace' ? (
          <section className="proc-page">
            <div className="proc-page-intro">
              <div><p className="eyebrow">GOAL → VALIDATED BASKET → HUMAN APPROVAL</p><h1>Plan a purchase with confidence.</h1><p>AI proposes from a real curated demo catalog. Deterministic rules check the basket. You approve the exact version before PayPal Sandbox checkout.</p></div>
              <div className="process-ribbon"><span>Describe</span><i>→</i><span>Clarify</span><i>→</i><span>Review</span><i>→</i><span>Approve</span><i>→</i><span>Pay</span></div>
            </div>
            <div className="proc-workspace-grid">
              <form className="proc-card goal-form" onSubmit={createProject}>
                <header className="proc-card-heading"><div><p className="eyebrow">New procurement project</p><h2>What are you organising?</h2></div><span className="usd-pill">USD only</span></header>
                <label className="proc-field"><span>Project title <em>optional</em></span><input className="proc-input" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} maxLength={160} placeholder="Coding workshop supplies" /></label>
                <label className="proc-field"><span>Describe the goal</span><textarea className="proc-input goal-textarea" value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={4000} required placeholder={'Equip a coding workshop for 40 students within $600, keeping 10% as contingency.'} /></label>
                <div className="proc-form-grid">
                  <label className="proc-field"><span>Beneficiaries <em>optional if in goal</em></span><input className="proc-input" type="number" min="1" max="10000" step="1" value={beneficiaryCount} onChange={(event) => setBeneficiaryCount(event.target.value)} placeholder="40" /></label>
                  <label className="proc-field"><span>Total budget (USD) <em>optional if in goal</em></span><input className="proc-input" inputMode="decimal" value={budgetUsd} onChange={(event) => setBudgetUsd(event.target.value)} placeholder="600.00" /></label>
                  <label className="proc-field"><span>Contingency (USD) <em>optional if in goal</em></span><input className="proc-input" inputMode="decimal" value={contingencyUsd} onChange={(event) => setContingencyUsd(event.target.value)} placeholder="60.00" /></label>
                  <div className="budget-rule-note"><strong>Planning allocation only</strong><span>TrustGate does not hold or reserve money for you.</span></div>
                </div>
                <footer className="proc-actions"><button className="proc-button primary" type="submit" disabled={busy || !goal.trim()}>{busy ? 'Saving & extracting…' : 'Create project & extract requirements'}</button></footer>
                <p className="proc-hint">The AI may ask follow-up questions. It cannot invent stock, prices, compatibility, or payment status.</p>
              </form>
              <aside className="proc-card workspace-side">
                <p className="eyebrow">Single merchant · demo inventory</p>
                <h2>{merchant?.name || 'TrustGate Demo Supplies Store'}</h2>
                <p>All listed products, stock, shipping, and taxes are explicitly demo-store data—not real-world offers.</p>
                <div className="store-rule"><span>Fixed demo shipping</span><strong>{money(merchant?.shippingMinor)}</strong></div>
                <div className="store-rule"><span>Demo tax</span><strong>{money(merchant?.taxMinor)}</strong></div>
                <button className="proc-button secondary" onClick={() => setPage('catalog')}>Browse curated catalog</button>
                <div className="sandbox-summary"><strong>Sandbox payment</strong><span>PayPal buyer approval is required. No automatic purchasing.</span></div>
              </aside>
            </div>

            <section className="proc-project-list-section">
              <header className="proc-section-heading"><div><p className="eyebrow">Your saved work</p><h2>Procurement projects</h2></div><button className="proc-icon-button" onClick={() => { loadWorkspace().catch((requestError) => setError(requestError.message)) }} aria-label="Refresh projects">↻</button></header>
              {projects.length === 0 ? <div className="proc-empty">No projects yet. Start by describing a goal above.</div> : (
                <div className="project-list">
                  {projects.map((entry) => (
                    <button className="project-list-card" key={entry._id} onClick={() => chooseProject(entry._id)}>
                      <span className="project-list-top"><strong>{entry.title}</strong><span className={`status-chip ${entry.status === 'NEEDS_CLARIFICATION' ? 'attention' : ''}`}>{entry.status.replace(/_/g, ' ')}</span></span>
                      <span>{entry.originalGoal}</span>
                      <span className="project-list-meta">{entry.beneficiaryCount} beneficiaries · usable budget {money(entry.budgetMinor - entry.contingencyMinor)} · updated {dateLabel(entry.updatedAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </section>
        ) : (
          <section className="proc-page">
            {!project ? (
              <div className="proc-empty"><p>Select a procurement project to review.</p><button className="proc-button primary" onClick={() => setPage('workspace')}>Go to workspace</button></div>
            ) : (
              <>
                <div className="review-page-heading">
                  <div><p className="eyebrow">HUMAN REVIEW · NO AUTO-PURCHASING</p><h1>{project.title}</h1><p>{project.originalGoal}</p></div>
                  <select className="proc-input project-picker" value={project._id} onChange={(event) => chooseProject(event.target.value)} aria-label="Select project">
                    {projects.map((entry) => <option key={entry._id} value={entry._id}>{entry.title} · {entry.status.replace(/_/g, ' ')}</option>)}
                  </select>
                </div>
                <div className="project-metrics">
                  <div><span>Beneficiaries</span><strong>{project.beneficiaryCount}</strong></div>
                  <div><span>Total budget</span><strong>{money(project.budgetMinor)}</strong></div>
                  <div><span>Contingency</span><strong>{money(project.contingencyMinor)}</strong></div>
                  <div><span>Usable budget</span><strong>{money(project.budgetMinor - project.contingencyMinor)}</strong></div>
                </div>
                {project.aiStatus === 'FAILED' && (
                  <div className="proc-alert warning"><span>AI extraction failed. Your project is saved; retry extraction or build a basket from the curated catalog.</span><button className="proc-button secondary" onClick={retryExtraction} disabled={busy}>{busy ? 'Retrying…' : 'Retry extraction'}</button></div>
                )}
                <ClarificationPanel key={`${project._id}-${project.updatedAt}`} project={project} onSubmit={saveClarifications} busy={clarificationBusy} />
                {project.clarificationQuestions?.some((question) => question.answer?.trim()) && project.aiStatus === 'READY' && (
                  <div className="proc-alert">
                    <span>Refresh AI interpretation to apply saved clarifications to catalog suggestions. Existing plans will be superseded and assumptions must be confirmed again.</span>
                    <button className="proc-button secondary" onClick={retryExtraction} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh AI requirements from answers'}</button>
                  </div>
                )}
                <section className="proc-card">
                  <header className="proc-card-heading">
                    <div><p className="eyebrow">02 · AI proposal</p><h2>Review the agent’s basket options</h2></div>
                    <div className="proc-actions">
                      <button className="proc-button secondary" onClick={() => setBasketEditor({ planId: null, items: [] })} disabled={busy}>Build basket</button>
                      <button className="proc-button primary" onClick={generatePlans} disabled={busy || project.status === 'NEEDS_CLARIFICATION'}>{busy ? 'Checking catalog…' : 'Generate validated options'}</button>
                    </div>
                  </header>
                  <p className="proc-muted">AI candidates are restricted to this store’s catalog. Server rules independently check integer quantities, stock, compatibility, subtotal, shipping, tax, and usable budget.</p>
                  {plans.length > 0 && (
                    <div className="plan-tabs" role="tablist" aria-label="Plan versions">
                      {plans.map((plan) => (
                        <button key={plan._id} role="tab" aria-selected={selectedPlanId === plan._id} className={selectedPlanId === plan._id ? 'active' : ''} onClick={() => { setSelectedPlanId(plan._id); setBasketEditor(null) }}>
                          v{plan.version} · {plan.strategy.replace(/_/g, ' ')} · {money(plan.totalMinor)}
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedPlan ? (
                    <PlanReview
                      project={project}
                      plan={selectedPlan}
                      catalog={catalog}
                      requirements={requirements}
                      approval={approvalForDisplay}
                      attempt={currentAttempt}
                      paypal={paypal}
                      api={api}
                      onEdit={() => setBasketEditor({ planId: selectedPlan._id, items: selectedPlan.items })}
                      onApprove={() => approvePlan(selectedPlan)}
                      onMessage={messageFromPaypal}
                      onRefresh={refreshFromPaypal}
                      busy={busy}
                    />
                  ) : (
                    <div className="proc-empty plan-empty">
                      <strong>{project.aiStatus === 'FAILED' ? 'No AI plan was created.' : 'No basket version yet.'}</strong>
                      <span>Answer critical questions, confirm assumptions, then generate options or create a manual basket.</span>
                    </div>
                  )}
                  {basketEditor && (
                    <BasketEditor
                      catalog={catalog}
                      requirements={requirements}
                      initialItems={basketEditor.items}
                      title={basketEditor.planId ? 'Edit basket · this creates a new plan version' : 'Create a manual basket'}
                      onSave={saveBasket}
                      onCancel={() => setBasketEditor(null)}
                      busy={busy}
                    />
                  )}
                </section>
                <AuditPanel events={projectDetail.audit || []} />
              </>
            )}
          </section>
        )}
      </main>
      <footer className="proc-footer">
        <span>TrustGate Procurement · local-only demo</span>
        <span>Budget is a planning allocation, not money held by TrustGate.</span>
        <button onClick={() => setPage('guide')}>How to use TrustGate</button>
      </footer>
    </div>
  )
}

function PlanReview({ project, plan, catalog, requirements, approval, attempt, paypal, api, onEdit, onApprove, onMessage, onRefresh, busy }) {
  const [showPaypal, setShowPaypal] = useState(false)
  const productBySku = new Map(catalog.map((product) => [product.sku, product]))
  const currentDiff = plan.items.flatMap((item) => {
    const product = productBySku.get(item.sku)
    if (!product) return [`${item.sku} is no longer in the active catalog.`]
    const differences = []
    if (product.unitPriceMinor !== item.unitPriceMinor) {
      differences.push(`${item.sku} price changed from ${money(item.unitPriceMinor)} to ${money(product.unitPriceMinor)} per item.`)
    }
    if (product.catalogVersion !== item.catalogVersion || product.merchantId !== item.merchantId) {
      differences.push(`${item.sku} catalog version or merchant identity changed.`)
    }
    if (!attempt && product.availableStock < item.quantity) {
      differences.push(`${item.sku} now has ${product.availableStock} available; this plan requests ${item.quantity}.`)
    }
    return differences
  })
  const optionalUnmet = (plan.unmetRequirements || []).filter((description) => (
    requirements.some((requirement) => !requirement.required && requirement.description === description)
  ))
  const expired = approval && new Date(approval.expiresAt).getTime() <= Date.now()
  const approvable = ['VALIDATED', 'APPROVED'].includes(plan.status)

  return (
    <div className="plan-review">
      <div className="plan-strategy-banner">
        <div><span className="strategy-label">{plan.strategy.replace(/_/g, ' ')}</span><p>{plan.strategyExplanation}</p></div>
        <span className={`status-chip ${approvable && plan.validationReport?.valid ? 'good' : 'attention'}`}>{plan.status === 'SUPERSEDED' ? 'Superseded · historical version' : plan.status === 'COMPLETED' ? 'Purchase completed' : plan.validationReport?.valid && approvable ? 'Deterministic checks passed' : 'Draft · validation issues'}</span>
      </div>
      <div className="proc-plan-layout">
        <div className="plan-lines">
          <h3>Exact basket · version {plan.version}</h3>
          {plan.items.length ? plan.items.map((item) => (
            <div className="plan-line" key={item.sku}>
              <span className="plan-product-image">{productBySku.get(item.sku)?.imagePath ? <img src={productBySku.get(item.sku).imagePath} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : '□'}</span>
              <span className="plan-line-info"><strong>{item.nameSnapshot}</strong><small>{item.sku} · {item.categorySnapshot} · {item.quantity} × {money(item.unitPriceMinor)}</small></span>
              <strong>{money(item.quantity * item.unitPriceMinor)}</strong>
            </div>
          )) : <p className="proc-muted">No items in this basket.</p>}
          <div className="plan-totals">
            <div><span>Subtotal</span><strong>{money(plan.subtotalMinor)}</strong></div>
            <div><span>Fixed demo shipping</span><strong>{money(plan.shippingMinor)}</strong></div>
            <div><span>Demo tax · not real-world tax</span><strong>{money(plan.taxMinor)}</strong></div>
            <div className="total-row"><span>Total · USD</span><strong>{money(plan.totalMinor)}</strong></div>
            <div><span>Usable budget</span><strong>{money(project.budgetMinor - project.contingencyMinor)}</strong></div>
            <div className="budget-remaining"><span>Remaining after this basket</span><strong>{money(project.budgetMinor - project.contingencyMinor - plan.totalMinor)}</strong></div>
          </div>
        </div>
        <aside className="plan-validation">
          <h3>Validation &amp; trade-offs</h3>
          {(plan.validationReport?.blockingIssues || []).length > 0 ? (
            <div className="validation-list blocking"><strong>Cannot approve yet</strong><ul>{plan.validationReport.blockingIssues.map((item) => <li key={item}>{item}</li>)}</ul></div>
          ) : <p className="validation-pass">✓ Basket is within usable budget and available demo stock.</p>}
          {currentDiff.length > 0 && <div className="validation-list blocking"><strong>Current catalog changes · review a new version</strong><ul>{currentDiff.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          {optionalUnmet.length > 0 && <div className="validation-list"><strong>Optional coverage omitted</strong><ul>{optionalUnmet.map((item) => <li key={item}>{item}</li>)}</ul></div>}
          {(plan.warnings || []).map((warning) => <p className="proc-hint" key={warning}>{warning}</p>)}
          <div className="mapping-list">
            <strong>Requirement mapping</strong>
            {plan.requirementMappings.map((mapping) => {
              const req = requirements.find((entry) => entry.key === mapping.requirementKey)
              return <div key={`${mapping.requirementKey}-${mapping.sku}`}><span>{req?.description || mapping.requirementKey}{mapping.rationale && <small>{mapping.rationale}</small>}</span><b>{mapping.quantity} × {mapping.sku}</b></div>
            })}
          </div>
        </aside>
      </div>
      <div className="proc-actions plan-review-actions">
        <button className="proc-button secondary" onClick={onEdit} disabled={busy || ['CHECKOUT', 'COMPLETED'].includes(project.status)}>Edit basket · create new version</button>
        {!approval || expired ? (
          <button className="proc-button primary" onClick={onApprove} disabled={busy || !approvable || !plan.validationReport?.valid || !project.assumptionsConfirmedAt || project.status === 'NEEDS_CLARIFICATION'}>
            {expired ? 'Approval expired · approve again' : 'Approve exact version'}
          </button>
        ) : (
          <span className="approved-notice">Approved v{approval.planVersion} · {money(approval.approvedTotalMinor)} · expires {dateLabel(approval.expiresAt)}</span>
        )}
      </div>
      {approval && (!expired || attempt) && (
        <section className="checkout-panel">
          <div><p className="eyebrow">03 · PayPal Sandbox Checkout</p><h3>Payment requires organiser and buyer action</h3><p className="proc-muted">A budget allocation is not a payment. TrustGate reserves demo stock before order creation, and consumes it only after PayPal confirms capture.</p></div>
          {attempt?.executionState === 'COMPLETED' ? (
            <p className="payment-complete">✓ PayPal payment captured and demo stock committed. Capture ID: {attempt.captureId}</p>
          ) : attempt && (['RECONCILIATION_REQUIRED', 'CAPTURE_PENDING', 'ORDER_CREATING'].includes(attempt.executionState) || expired) ? (
            <div className="proc-alert warning">
              <strong>Checkout is held for reconciliation.</strong>
              <span>{attempt.sanitizedError || 'Do not start a second order or release this reservation until the PayPal result is confirmed.'}</span>
              {attempt.paypalOrderId && (
                <div className="proc-actions">
                  <button
                    className="proc-button primary"
                    onClick={async () => {
                      try {
                        const result = await api(`/projects/${project._id}/checkout/${attempt._id}/capture`, { method: 'POST' })
                        onMessage(result.completed ? 'PayPal capture is confirmed and the reservation was committed.' : 'PayPal payment state checked.')
                      } catch (error) {
                        onMessage(formatRequestError(error))
                      }
                      await onRefresh()
                    }}
                  >
                    Reconcile PayPal payment
                  </button>
                  <button
                    className="proc-button secondary"
                    onClick={async () => {
                      try {
                        const result = await api(`/projects/${project._id}/checkout/${attempt._id}/cancel`, { method: 'POST' })
                        onMessage(result.released ? 'PayPal confirmed cancellation; the demo stock and budget reservation were released.' : 'PayPal state checked.')
                      } catch (error) {
                        onMessage(formatRequestError(error))
                      }
                      await onRefresh()
                    }}
                  >
                    Check cancellation status
                  </button>
                </div>
              )}
            </div>
          ) : !paypal?.configured ? (
            <p className="proc-alert warning">PayPal Sandbox credentials are not configured. This exact plan remains approved; no purchase was attempted.</p>
          ) : !paypal.clientId ? (
            <p className="proc-alert warning">PayPal Sandbox Client ID is not available to the browser. Confirm backend configuration.</p>
          ) : (
            <div className="paypal-sdk-wrap">
              {attempt && <p className="attempt-status">Checkout state: <strong>{attempt.executionState.replace(/_/g, ' ')}</strong>{attempt.sanitizedError ? ` · ${attempt.sanitizedError}` : ''}</p>}
              {!showPaypal ? (
                <button className="proc-button primary" onClick={() => setShowPaypal(true)}>Continue to PayPal Sandbox</button>
              ) : (
                <PayPalButtons
                  key={`${approval._id}-${attempt?._id || 'new'}`}
                  clientId={paypal.clientId}
                  projectId={project._id}
                  approval={approval}
                  existingAttempt={attempt}
                  api={api}
                  onMessage={onMessage}
                  onRefresh={onRefresh}
                />
              )}
            </div>
          )}
        </section>
      )}
      {attempt && attempt.executionState === 'RECONCILIATION_REQUIRED' && (
        <div className="proc-alert warning">
          <strong>Financial/inventory reconciliation required.</strong>
          <span>Do not create a replacement checkout or release this reservation until the PayPal order is checked and reconciled.</span>
        </div>
      )}
    </div>
  )
}

function CatalogPage({ merchant, catalog }) {
  return (
    <section className="proc-page">
      <div className="proc-page-intro catalog-intro"><div><p className="eyebrow">ONE MERCHANT · CURATED SKU LIST</p><h1>Demo supplies catalog</h1><p>Inventory, stock, and prices below are test data held in MongoDB—not live market offers.</p></div><span className="demo-inventory-tag">DEMO INVENTORY</span></div>
      <div className="merchant-rules">
        <div><span>Merchant</span><strong>{merchant?.name || 'TrustGate Demo Supplies Store'}</strong></div>
        <div><span>Shipping</span><strong>{money(merchant?.shippingMinor)} fixed demo fee</strong></div>
        <div><span>Tax</span><strong>{money(merchant?.taxMinor)} demo configuration</strong></div>
        <div><span>Delivery</span><strong>Not confirmed</strong></div>
      </div>
      <div className="catalog-grid">
        {catalog.map((product) => (
          <article className="catalog-card" key={product.sku}>
            <div className="catalog-image">{product.imagePath ? <img src={product.imagePath} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : <span aria-hidden="true">▧</span>}<small>DEMO</small></div>
            <div className="catalog-product-info"><span className="catalog-category">{product.category}</span><h2>{product.name}</h2><p>{product.description}</p><div className="catalog-tags">{(product.compatibilityTags || []).map((tag) => <span key={tag}>{tag}</span>)}</div><footer><strong>{money(product.unitPriceMinor)}</strong><span>{product.availableStock} available</span></footer></div>
          </article>
        ))}
      </div>
    </section>
  )
}

function AuditPanel({ events }) {
  return (
    <section className="proc-card audit-panel">
      <header className="proc-card-heading"><div><p className="eyebrow">04 · Traceability</p><h2>Project audit trail</h2></div><span>{events.length} recent event{events.length === 1 ? '' : 's'}</span></header>
      {events.length ? (
        <ol className="audit-event-list">
          {events.map((event) => <li key={event._id}><time>{dateLabel(event.timestamp)}</time><span className={`audit-actor ${event.actor.toLowerCase()}`}>{event.actor}</span><div><strong>{event.eventType.replace(/_/g, ' ')}</strong><p>{event.reason}</p>{event.metadata?.version && <small>Plan version {event.metadata.version}{event.metadata.totalMinor ? ` · ${money(event.metadata.totalMinor)}` : ''}</small>}</div></li>)}
        </ol>
      ) : <div className="proc-empty">No project events recorded yet.</div>}
    </section>
  )
}

function GuidePage({ onOpenWorkspace }) {
  return (
    <section className="proc-page guide-page">
      <div className="proc-page-intro"><div><p className="eyebrow">TRUSTGATE PROCUREMENT · QUICK GUIDE</p><h1>From a goal to a reviewed purchase.</h1><p>AI proposes. Code validates. You decide. PayPal Sandbox processes only after approval.</p></div></div>
      <div className="guide-layout">
        <article className="proc-card guide-main">
          <div className="guide-step"><span>1</span><div><h2>Describe the goal</h2><p>Include what you are organising, audience size, total USD budget, contingency, deadline, required items, equipment you already have, and any compatibility needs. Do not assume one device per attendee unless you really need that.</p></div></div>
          <div className="guide-step"><span>2</span><div><h2>Answer critical questions</h2><p>TrustGate asks when a missing count, quantity, or budget could change the basket. Answer these and explicitly confirm the demo-store and delivery assumptions before approval.</p></div></div>
          <div className="guide-step"><span>3</span><div><h2>Review AI proposals</h2><p>Compare available strategies and exact SKU quantities. AI suggestions are limited to the curated catalog. The server checks stock, duplicate quantities, requirements, compatibility tags, USD cents, fixed demo shipping/tax, and contingency-adjusted budget.</p></div></div>
          <div className="guide-step"><span>4</span><div><h2>Edit or build a basket</h2><p>Choose products and quantities; TrustGate automatically links matching required items to the basket. Edits create a new plan version and invalidate earlier approvals.</p></div></div>
          <div className="guide-step"><span>5</span><div><h2>Approve the exact version</h2><p>Approval records plan version, content hash, amount, and expiry. Review the total and assumptions. Any changed plan requires another approval.</p></div></div>
          <div className="guide-step"><span>6</span><div><h2>Complete Sandbox Checkout</h2><p>Choose Continue to PayPal, sign in with a PayPal Sandbox buyer, and approve. TrustGate captures server-side only after buyer approval and verifies the returned amount/currency. Demo inventory is consumed only after confirmed capture.</p></div></div>
          <div className="guide-step"><span>7</span><div><h2>Use the audit trail</h2><p>Review requirement extraction, changes, plan versions, approval, reservation, PayPal order, and capture events on the project page. If a financial result is ambiguous, TrustGate holds the reservation for reconciliation rather than silently releasing it.</p></div></div>
          <footer className="guide-safety"><strong>Local-only safety boundary</strong><p>This application has no owner authentication yet. Keep it on your machine; do not expose it on a public network. Budget and inventory reservations are planning/demo records, not funds held by TrustGate. Sandbox checkout is not a real purchase.</p></footer>
        </article>
        <aside className="proc-card guide-aside"><p className="eyebrow">What TrustGate does not do</p><ul><li>No scraping or arbitrary merchant checkout</li><li>No multi-seller settlement, payout, or escrow</li><li>No automatic purchase or AI approval</li><li>No guaranteed delivery ETA or real tax calculation</li><li>No public deployment before owner authentication</li></ul><p className="eyebrow">Troubleshooting</p><p><strong>No plan?</strong> Retry AI extraction or build a manual basket.</p><p><strong>Stock/price changed?</strong> Review a new plan version before approval.</p><p><strong>Checkout says reconciliation?</strong> Do not retry with a new key or release the reservation until PayPal state is confirmed.</p><button className="proc-button primary" onClick={onOpenWorkspace}>Open procurement workspace</button></aside>
      </div>
    </section>
  )
}
