import { useState, useEffect, useCallback } from 'react'
import ProcurementApp from './ProcurementApp'

const API = '/api'

function fmtMoney(value, currency) {
  const fractionDigits = ['HUF', 'JPY', 'TWD'].includes(currency) ? 0 : 2
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(Number(value || 0))
  } catch {
    return `${Number(value || 0).toFixed(fractionDigits)} ${currency || 'USD'}`
  }
}

function autonomyPct(score) {
  if (score == null) return null
  if (score >= 90) return 80
  if (score >= 70) return 50
  if (score >= 40) return 20
  return 0
}

function ringColor(score) {
  if (score == null) return '#6b7a96'
  if (score >= 90) return '#38bdf8'
  if (score >= 70) return '#2563eb'
  if (score >= 40) return '#fbbf24'
  return '#fb7185'
}

function ringLabel(score) {
  if (score == null) return '—'
  if (score >= 90) return 'High autonomy'
  if (score >= 70) return 'Moderate autonomy'
  if (score >= 40) return 'Restricted'
  return 'Blocked'
}

function pctOf(score) {
  if (score == null) return 0
  return Math.round((score / 100) * 251.327)
}

function App() {
  const [agents, setAgents] = useState([])
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [showRegister, setShowRegister] = useState(false)
  const [editingPayment, setEditingPayment] = useState(null)
  const [editQuote, setEditQuote] = useState(null)
  const [editQuoteLoading, setEditQuoteLoading] = useState(false)
  const [editQuoteError, setEditQuoteError] = useState('')
  const [savingPaymentEdit, setSavingPaymentEdit] = useState(false)
  const [trustData, setTrustData] = useState(null)
  const [submittingPayment, setSubmittingPayment] = useState(false)
  const [registeringAgent, setRegisteringAgent] = useState(false)
  const [busyPaymentId, setBusyPaymentId] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [trustRefresh, setTrustRefresh] = useState(0)
  const [paypalConfig, setPaypalConfig] = useState(null)
  const [paypalStatusError, setPaypalStatusError] = useState('')
  const [paymentAmount, setPaymentAmount] = useState('')
  const [sourceCurrency, setSourceCurrency] = useState('INR')
  const [checkoutCurrency, setCheckoutCurrency] = useState('USD')
  const [fxQuote, setFxQuote] = useState(null)
  const [fxLoading, setFxLoading] = useState(false)
  const [fxError, setFxError] = useState('')
  const editAmount = editingPayment?.amount
  const editSourceCurrency = editingPayment?.sourceCurrency
  const editCurrency = editingPayment?.currency

  const showToast = useCallback((msg, type = 'error') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }, [])

  const api = useCallback(async (path, opts = {}) => {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(data?.error || `API request failed (${res.status} ${res.statusText})`)
    }
    if (data === null) {
      throw new Error(`The server returned an invalid response for ${path}. Check that the dashboard is connected to the backend API.`)
    }
    return data
  }, [])

  const fetchData = useCallback(async () => {
    const [agentsData, paymentsData] = await Promise.all([api('/agents'), api('/payments')])
    return { agentsData, paymentsData }
  }, [api])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { agentsData, paymentsData } = await fetchData()
      setAgents(agentsData)
      setPayments(paymentsData)
      setSelectedAgentId((current) => (
        agentsData.some((agent) => agent._id === current)
          ? current
          : agentsData.find((agent) => agent.status === 'ACTIVE')?._id || agentsData[0]?._id || ''
      ))
    } catch (e) {
      showToast(e.message)
    } finally {
      setLoading(false)
    }
  }, [fetchData, showToast])

  useEffect(() => {
    let active = true
    fetchData()
      .then(({ agentsData, paymentsData }) => {
        if (active) {
          setAgents(agentsData)
          setPayments(paymentsData)
          setSelectedAgentId((current) => (
            agentsData.some((agent) => agent._id === current)
              ? current
              : agentsData.find((agent) => agent.status === 'ACTIVE')?._id || agentsData[0]?._id || ''
          ))
          setLoading(false)
        }
      })
      .catch((e) => {
        if (active) {
          showToast(e.message)
          setLoading(false)
        }
      })
    return () => { active = false }
  }, [fetchData, showToast])

  useEffect(() => {
    let active = true
    api('/payments/paypal/status')
      .then((status) => {
        if (active) {
          setPaypalConfig(status)
          setPaypalStatusError('')
        }
      })
      .catch((err) => {
        if (active) {
          setPaypalConfig(null)
          setPaypalStatusError(err.message)
        }
      })
    return () => { active = false }
  }, [api])

  useEffect(() => {
    const amount = Number(paymentAmount)
    if (!paymentAmount || !Number.isFinite(amount) || amount <= 0) {
      return undefined
    }

    let active = true
    const timeout = setTimeout(() => {
      setFxLoading(true)
      setFxError('')
      api(`/payments/fx/quote?amount=${encodeURIComponent(amount)}&from=${encodeURIComponent(sourceCurrency)}&to=${encodeURIComponent(checkoutCurrency)}`)
        .then((quote) => {
          if (active) setFxQuote(quote)
        })
        .catch((err) => {
          if (active) {
            setFxQuote(null)
            setFxError(err.message)
          }
        })
        .finally(() => {
          if (active) setFxLoading(false)
        })
    }, 250)

    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [paymentAmount, sourceCurrency, checkoutCurrency, api])

  useEffect(() => {
    if (editAmount === undefined || !editSourceCurrency || !editCurrency) return undefined

    const amount = Number(editAmount)
    if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(editSourceCurrency)) {
      return undefined
    }

    let active = true
    const timeout = setTimeout(() => {
      setEditQuoteLoading(true)
      setEditQuoteError('')
      api(`/payments/fx/quote?amount=${encodeURIComponent(amount)}&from=${encodeURIComponent(editSourceCurrency)}&to=${encodeURIComponent(editCurrency)}`)
        .then((quote) => {
          if (active) setEditQuote(quote)
        })
        .catch((err) => {
          if (active) {
            setEditQuote(null)
            setEditQuoteError(err.message)
          }
        })
        .finally(() => {
          if (active) setEditQuoteLoading(false)
        })
    }, 250)

    return () => {
      active = false
      clearTimeout(timeout)
    }
  }, [editAmount, editSourceCurrency, editCurrency, api])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
    setTrustRefresh((version) => version + 1)
  }

  const createAgent = async (e) => {
    e.preventDefault()
    const form = new FormData(e.target)
    const allowedCats = form.get('allowedCategories').split(',').map((s) => s.trim()).filter(Boolean)
    const blockedCats = form.get('blockedCategories').split(',').map((s) => s.trim()).filter(Boolean)
    setRegisteringAgent(true)
    try {
      await api('/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          ownerEmail: form.get('ownerEmail'),
          mandateLimit: Number(form.get('mandateLimit')),
          perTransactionLimit: Number(form.get('perTransactionLimit')),
          allowedCategories: allowedCats,
          blockedCategories: blockedCats,
        }),
      })
      setShowRegister(false)
      showToast('Agent registered', 'success')
      await load()
    } catch (err) {
      showToast(err.message)
    } finally {
      setRegisteringAgent(false)
    }
  }

  const requestPayment = async (e) => {
    e.preventDefault()
    const formElement = e.currentTarget
    const form = new FormData(formElement)
    const agentId = form.get('agentId')
    setSubmittingPayment(true)
    try {
      const payment = await api('/payments/request', {
        method: 'POST',
        body: JSON.stringify({
          agentId,
          recipientEmail: form.get('recipientEmail'),
          amount: Number(form.get('amount')),
          sourceCurrency: form.get('sourceCurrency'),
          currency: form.get('currency'),
          purpose: form.get('purpose'),
        }),
      })
      formElement.querySelectorAll('input[name="recipientEmail"], input[name="amount"], textarea[name="purpose"]')
        .forEach((field) => { field.value = '' })
      setPaymentAmount('')
      setFxQuote(null)
      setFxError('')
      const decisionLabel = payment.decision.replace(/_/g, ' ').toLowerCase()
      const resultMessage = payment.paypalStatus === 'FAILED'
        ? `Request ${decisionLabel}, but PayPal failed: ${payment.paypalError}`
        : payment.paypalLink
          ? `Request ${decisionLabel}. ${fmtMoney(payment.originalAmount ?? payment.amount, payment.originalCurrency || payment.currency)} was converted to ${fmtMoney(payment.amount, payment.currency)}. PayPal Checkout is ready.`
          : payment.decision === 'MANUAL_APPROVAL_REQUIRED'
            ? 'Request evaluated and sent for approval.'
            : `Request ${decisionLabel}.`
      showToast(resultMessage, payment.paypalStatus === 'FAILED' ? 'error' : 'success')
      await load()
      setTrustRefresh((version) => version + 1)
    } catch (err) {
      showToast(err.message)
    } finally {
      setSubmittingPayment(false)
    }
  }

  const approvePayment = async (id) => {
    setBusyPaymentId(id)
    try {
      const payment = await api(`/payments/${id}/approve`, { method: 'POST' })
      await load()
      setTrustRefresh((version) => version + 1)
      showToast(
        payment.paypalStatus === 'FAILED'
          ? `Payment approved, but PayPal Checkout failed: ${payment.paypalError}`
          : payment.paypalLink
            ? 'Payment approved. The buyer can now continue to PayPal Checkout.'
            : 'Payment approved.',
        payment.paypalStatus === 'FAILED' ? 'error' : 'success'
      )
    } catch (err) {
      showToast(err.message)
    } finally {
      setBusyPaymentId('')
    }
  }

  const rejectPayment = async (id) => {
    setBusyPaymentId(id)
    try {
      await api(`/payments/${id}/reject`, { method: 'POST' })
      await load()
      setTrustRefresh((version) => version + 1)
      showToast('Payment rejected', 'success')
    } catch (err) {
      showToast(err.message)
    } finally {
      setBusyPaymentId('')
    }
  }

  const openPaymentEditor = (payment) => {
    setEditingPayment({
      id: payment._id,
      recipientEmail: payment.recipientEmail,
      amount: String(payment.originalAmount ?? payment.amount),
      sourceCurrency: (payment.originalCurrency || payment.currency || 'USD').toUpperCase(),
      currency: (payment.currency || 'USD').toUpperCase(),
      purpose: payment.purpose,
    })
    setEditQuote(null)
    setEditQuoteError('')
    setEditQuoteLoading(false)
  }

  const savePaymentEdit = async (e) => {
    e.preventDefault()
    if (!editingPayment) return

    setSavingPaymentEdit(true)
    try {
      const payment = await api(`/payments/${editingPayment.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          recipientEmail: editingPayment.recipientEmail,
          amount: Number(editingPayment.amount),
          sourceCurrency: editingPayment.sourceCurrency,
          currency: editingPayment.currency,
          purpose: editingPayment.purpose,
        }),
      })
      setEditingPayment(null)
      setEditQuote(null)
      await load()
      setTrustRefresh((version) => version + 1)
      showToast(
        payment.paypalStatus === 'FAILED'
          ? `Updated and re-evaluated, but PayPal Checkout failed: ${payment.paypalError}`
          : payment.paypalLink
            ? 'Updated and re-evaluated. A new PayPal Checkout link is ready.'
            : `Updated and re-evaluated: ${payment.decision.replace(/_/g, ' ').toLowerCase()}.`,
        payment.paypalStatus === 'FAILED' ? 'error' : 'success'
      )
    } catch (err) {
      showToast(err.message)
    } finally {
      setSavingPaymentEdit(false)
    }
  }

  const retryPayPalOrder = async (id) => {
    setBusyPaymentId(id)
    try {
      const payment = await api(`/payments/${id}/paypal/retry`, { method: 'POST' })
      await load()
      showToast(
        payment.paypalLink
          ? 'PayPal Checkout order is ready. Open the payment link to continue.'
          : 'PayPal Checkout order created.',
        'success'
      )
    } catch (err) {
      await load()
      showToast(err.message)
    } finally {
      setBusyPaymentId('')
    }
  }

  const refreshPayPalStatus = async (id) => {
    setBusyPaymentId(id)
    try {
      const payment = await api(`/payments/${id}/paypal/status`, { method: 'POST' })
      await load()
      showToast(`PayPal order status: ${payment.paypalStatus}`, 'success')
    } catch (err) {
      showToast(err.message)
    } finally {
      setBusyPaymentId('')
    }
  }

  const capturePayPalPayment = async (id) => {
    setBusyPaymentId(id)
    try {
      const payment = await api(`/payments/${id}/paypal/capture`, { method: 'POST' })
      await load()
      showToast(
        payment.paypalStatus === 'COMPLETED'
          ? 'PayPal payment completed.'
          : `PayPal capture status: ${payment.paypalStatus}`,
        payment.paypalStatus === 'COMPLETED' ? 'success' : 'error'
      )
    } catch (err) {
      showToast(err.message)
      await load()
    } finally {
      setBusyPaymentId('')
    }
  }

  useEffect(() => {
    if (!selectedAgentId) return undefined
    let active = true
    api(`/agents/${selectedAgentId}/trust`)
      .then((data) => {
        if (active) setTrustData(data)
      })
      .catch((err) => {
        if (active) showToast(err.message)
      })
    return () => { active = false }
  }, [selectedAgentId, api, showToast, trustRefresh])

  useEffect(() => {
      if (!showRegister && !editingPayment) return undefined
      const closeOnEscape = (event) => {
        if (event.key === 'Escape' && !registeringAgent) setShowRegister(false)
        if (event.key === 'Escape' && !savingPaymentEdit) setEditingPayment(null)
      }
      window.addEventListener('keydown', closeOnEscape)
      return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showRegister, editingPayment, registeringAgent, savingPaymentEdit])

  const selectedAgent = agents.find((a) => a._id === selectedAgentId) || null
  const score = selectedAgent ? selectedAgent.trustScore : null
  const apct = autonomyPct(score)
  const ringDash = pctOf(score ?? 0)
  const rcolor = ringColor(score)
  const rlabel = ringLabel(score)
  const currency = 'USD'
  const pendingCount = payments.filter((p) => p.decision === 'MANUAL_APPROVAL_REQUIRED' && p.humanDecision === 'PENDING').length
  const trustForSelectedAgent = trustData?.agentId === selectedAgentId ? trustData : null
  const approvedPayments = selectedAgent
    ? payments.filter((payment) => (
      String(payment.agentId) === selectedAgent._id
      && (payment.decision === 'AUTO_APPROVED' || payment.humanDecision === 'APPROVED')
    ))
    : []
  const approvedVolume = approvedPayments.reduce((total, payment) => total + payment.amount, 0)
  const canRequestPayment = selectedAgent?.status === 'ACTIVE'
  const hasCurrentQuote = fxQuote?.amount === Number(paymentAmount)
    && fxQuote?.from === sourceCurrency
    && fxQuote?.to === checkoutCurrency
  const hasCurrentEditQuote = editQuote?.amount === Number(editingPayment?.amount)
    && editQuote?.from === editingPayment?.sourceCurrency
    && editQuote?.to === editingPayment?.currency

  return (
    <div className="app">
      {toast && (
        <div className={`toast toast-${toast.type}`} role="status" aria-live="polite">{toast.msg}</div>
      )}

      <header className="header">
        <a className="brand" href="#overview" aria-label="TrustGate overview">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5"/>
            <path d="M2 12l10 5 10-5"/>
          </svg>
          <span>TrustGate</span>
        </a>
        <div className="header-actions">
          <span className={`sandbox-badge ${paypalConfig?.configured ? 'configured' : 'needs-setup'}`}>
            PayPal Sandbox · {paypalConfig ? (paypalConfig.configured ? 'Credentials set' : 'Setup needed') : 'Checking'}
          </span>
          <nav className="nav" aria-label="Main navigation">
            <a className="nav-item" href="#overview">Overview</a>
            <a className="nav-item" href="#agents">Agents</a>
            <a className="nav-item" href="#payments">Payments</a>
            <a className="nav-item" href="#activity">Activity</a>
          </nav>
          <button className="btn secondary btn-sm refresh-button" type="button" onClick={refresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="main-wrap">
        <div className="page-intro" id="overview">
          <div className="page-heading">
            <h1>Agent payment control</h1>
            <p>Evaluate, authorize, and audit AI agent payment requests through PayPal Sandbox.</p>
          </div>

          <div className="summary-grid">
            <div className="summary-card">
              <span className="stat-label">Selected agent</span>
              <span className="stat-value">{selectedAgent?.name || '—'}</span>
            </div>
            <div className="summary-card">
              <span className="stat-label">Trust score</span>
              <span className="stat-value" style={{ color: rcolor }}>{score == null ? '—' : score}</span>
            </div>
            <div className="summary-card">
              <span className="stat-label">Autonomous allowance</span>
              <span className="stat-value">{apct == null ? '—' : apct}%</span>
            </div>
            <div className="summary-card">
              <span className="stat-label">Pending approvals</span>
              <span className="stat-value" style={{ color: '#fbbf24' }}>{pendingCount}</span>
            </div>
          </div>
        </div>

        <div className="shell">
          <aside className="left-zone">
            <section className="card trust-card" id="trust-panel">
              <div className="trust-hero">
                <div className="ring-wrap">
                  <svg className="ring-svg" viewBox="0 0 100 100">
                    <circle className="ring-bg" cx="50" cy="50" r="40" />
                    <circle
                      className="ring-path"
                      cx="50"
                      cy="50"
                      r="40"
                      stroke={rcolor}
                      strokeDasharray="251.327"
                      strokeDashoffset={251.327 - ringDash}
                    />
                  </svg>
                  <div className="ring-text">
                    <span className="ring-value">{score == null ? '—' : score}</span>
                    <span className="ring-sub">trust</span>
                  </div>
                </div>
                <div className="trust-info">
                  <h2>{score == null ? 'No agent selected' : rlabel}</h2>
                  <p>
                    {score == null
                      ? 'Select an agent to view trust and autonomy details.'
                      : `Agent may auto-approve up to ${apct}% of its mandate.`}
                  </p>
                  {score != null && (
                    <div className="trust-meta">
                      <span className="trust-meta-item">Mandate {fmtMoney(selectedAgent.mandateLimit, currency)}</span>
                      <span className="trust-meta-item">Auto-spend {fmtMoney(selectedAgent.mandateLimit * (apct / 100), currency)}</span>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="card autonomy-card">
              <div className="autonomy-header">
                <p className="label">Autonomous spending</p>
                <span className="autonomy-pct">{apct == null ? '—' : apct}%</span>
              </div>
              <div className="autonomy-bar-wrap">
                <div className="autonomy-bar" style={{ width: `${apct == null ? 0 : apct}%` }}></div>
              </div>
              {score != null ? (
                <>
                  <p className="autonomy-note">
                    {fmtMoney(selectedAgent.mandateLimit * (apct / 100), currency)} of {fmtMoney(selectedAgent.mandateLimit, currency)} can be auto-approved.
                  </p>
                  <div className="autonomy-breakdown">
                    <div className="autonomy-breakdown-item">
                      <span className="ab-value">{fmtMoney(selectedAgent.mandateLimit, currency)}</span>
                      <span className="ab-label">Total mandate</span>
                    </div>
                    <div className="autonomy-breakdown-item">
                      <span className="ab-value" style={{ color: '#38bdf8' }}>{apct}%</span>
                      <span className="ab-label">Auto-approved</span>
                    </div>
                    <div className="autonomy-breakdown-item">
                      <span className="ab-value" style={{ color: '#fbbf24' }}>{100 - apct}%</span>
                      <span className="ab-label">Human approval</span>
                    </div>
                  </div>
                </>
              ) : (
                <p className="autonomy-note" style={{ color: '#6b7a96' }}>Select an agent to view the autonomy allowance.</p>
              )}
            </section>

            <section className="card mandate-card">
              <p className="label">Approved volume</p>
              <div className="approved-volume">
                <strong>{selectedAgent ? fmtMoney(approvedVolume, currency) : '—'}</strong>
                <span>
                  {selectedAgent
                    ? `${approvedPayments.length} approved ${approvedPayments.length === 1 ? 'request' : 'requests'}`
                    : 'Select an agent to view approved requests.'}
                </span>
              </div>
            </section>

            <section className="card agents-list" id="agents">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <p className="label section-title">Registered agents</p>
                <button className="btn secondary btn-sm" type="button" onClick={() => setShowRegister(true)}>Register agent</button>
              </div>
              <div className="agent-rows">
                {loading ? (
                  <p className="empty">Loading agents…</p>
                ) : agents.length === 0 ? (
                  <div className="empty-agent-state">
                    <p>No agents registered yet.</p>
                    <button className="btn secondary btn-sm" type="button" onClick={() => setShowRegister(true)}>
                      Register your first agent
                    </button>
                  </div>
                ) : (
                  agents.map((a) => (
                    <button
                      key={a._id}
                      type="button"
                      className={`agent-row ${selectedAgentId === a._id ? 'active' : ''}`}
                      aria-pressed={selectedAgentId === a._id}
                      onClick={() => setSelectedAgentId(a._id)}
                    >
                      <div className="agent-info">
                        <div className="agent-name">{a.name}</div>
                        <div className="agent-meta">{a.ownerEmail}</div>
                      </div>
                      <div className="agent-chip">
                        <span className={`dot ${a.status === 'ACTIVE' ? 'active' : 'inactive'}`}></span>
                        <span className="dot-label">{a.status}</span>
                      </div>
                      <div className="agent-score">{a.trustScore}</div>
                    </button>
                  ))
                )}
              </div>
            </section>
          </aside>

          <main className="right-zone" id="payments">
            <section className="card payment-form-card" id="request-payment">
              <div className="card-header">
                <h2>Agent payment request</h2>
                <p className="muted">Enter an amount in any supported source currency. It is converted before PayPal Checkout.</p>
              </div>
              {paypalStatusError && (
                <div className="paypal-setup-notice" role="status">
                  <strong>Could not check PayPal Sandbox configuration.</strong>
                  <span>
                    The dashboard could not read the backend's PayPal status. Make sure the API server is running and the
                    dashboard is using its API proxy, then reload this page.
                  </span>
                  <span>{paypalStatusError}</span>
                </div>
              )}
              {paypalConfig && !paypalConfig.configured && (
                <div className="paypal-setup-notice" role="status">
                  <strong>PayPal Sandbox Checkout is not configured.</strong>
                  <span>
                    Add {paypalConfig.missing?.join(', ') || 'valid PayPal credentials'} to the project root <code>.env</code>,
                    then restart the backend server. Use your Sandbox REST app credentials.
                  </span>
                  <a href="https://developer.paypal.com/dashboard/applications/sandbox" target="_blank" rel="noreferrer">
                    Open PayPal Sandbox apps
                  </a>
                </div>
              )}
              <form onSubmit={requestPayment} className="control-form grid-form">
                <div className="field">
                  <label className="field-label" htmlFor="payment-agent">Agent</label>
                  <select
                    className="input"
                    id="payment-agent"
                    name="agentId"
                    value={selectedAgentId}
                    onChange={(e) => setSelectedAgentId(e.target.value)}
                    required
                    disabled={loading || agents.length === 0}
                  >
                    <option value="">
                      {loading ? 'Loading agents…' : agents.length ? 'Select an agent' : 'No agents registered'}
                    </option>
                    {agents.map((a) => (
                      <option key={a._id} value={a._id}>
                        {a.name}{a.status === 'ACTIVE' ? '' : ' (revoked)'}
                      </option>
                    ))}
                  </select>
                  {!loading && !selectedAgent && agents.length === 0 && (
                    <p className="field-hint">
                      Use “Register agent” in the sidebar to create an agent before submitting a payment request.
                    </p>
                  )}
                  {!loading && !selectedAgent && agents.length > 0 && (
                    <p className="field-hint">Choose an agent to view its trust details and submit a request.</p>
                  )}
                  {selectedAgent && !canRequestPayment && (
                    <p className="field-hint">This agent is revoked and cannot submit payment requests.</p>
                  )}
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="buyer-email">Customer email</label>
                  <input className="input" id="buyer-email" name="recipientEmail" type="email" placeholder="customer@example.com" required />
                  <p className="field-hint">Used for request risk analysis. The buyer signs in to PayPal to approve checkout.</p>
                </div>
                <div className="field" style={{ display: 'flex', gap: '10px', flexDirection: 'column' }}>
                  <label className="field-label" htmlFor="payment-amount">Amount in source currency</label>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <input
                      className="input"
                      id="payment-amount"
                      name="amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="0.00"
                      value={paymentAmount}
                      onChange={(e) => {
                        setPaymentAmount(e.target.value)
                        setFxQuote(null)
                        setFxError('')
                        setFxLoading(false)
                      }}
                      required
                      style={{ flex: 1 }}
                    />
                    <input
                      className="input currency-code-input"
                      id="source-currency"
                      name="sourceCurrency"
                      type="text"
                      value={sourceCurrency}
                      onChange={(e) => {
                        setSourceCurrency(e.target.value.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase())
                        setFxQuote(null)
                        setFxError('')
                        setFxLoading(false)
                      }}
                      aria-label="Source currency code"
                      title="Enter a three-letter currency code, such as INR or EUR"
                      autoCapitalize="characters"
                      maxLength={3}
                      pattern="[A-Za-z]{3}"
                      required
                      style={{ width: '82px' }}
                    />
                    <select
                      className="input"
                      name="currency"
                      value={checkoutCurrency}
                      onChange={(e) => {
                        setCheckoutCurrency(e.target.value)
                        setFxQuote(null)
                        setFxError('')
                        setFxLoading(false)
                      }}
                      aria-label="PayPal checkout currency"
                      style={{ minWidth: '90px' }}
                    >
                      {(paypalConfig?.currencies || ['USD']).map((code) => (
                        <option key={code} value={code}>{code}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="field full fx-preview" aria-live="polite">
                  {fxLoading && <span>Getting the latest exchange rate…</span>}
                  {!fxLoading && fxError && <span className="fx-error">{fxError}</span>}
                  {!fxLoading && !fxError && fxQuote && (
                    <>
                      <strong>{fmtMoney(fxQuote.convertedAmount, fxQuote.to)} estimated checkout amount</strong>
                      <span>
                        {fxQuote.from === fxQuote.to
                          ? 'No conversion required; source and checkout currencies match.'
                          : `1 ${fxQuote.from} = ${fxQuote.rate.toFixed(6)} ${fxQuote.to}${fxQuote.rateUpdatedAt ? ` · rate updated ${fxQuote.rateUpdatedAt}` : ''}`}
                      </span>
                      <span>PayPal charges the converted amount shown above; the exact exchange rate may change before submission.</span>
                    </>
                  )}
                  {!paymentAmount && <span>Enter an amount and three-letter source currency code to preview the PayPal charge.</span>}
                </div>
                <div className="field full">
                  <label className="field-label">Purpose</label>
                  <textarea className="input" name="purpose" placeholder="e.g. cloud hosting subscription" required></textarea>
                </div>
                <button className="btn primary" type="submit" disabled={loading || submittingPayment || !canRequestPayment || !hasCurrentQuote || fxLoading}>
                  {submittingPayment ? 'Evaluating…' : 'Evaluate and continue'}
                </button>
                <p className="muted" style={{ fontSize: '0.82rem', marginTop: '6px' }}>Auto-approve only within the agent's autonomy allowance. Above that, human approval is required.</p>
              </form>
            </section>

            <section className="card">
              <div className="card-header">
                <h2>Payment decisions</h2>
                <p className="muted">Authorization decision is separate from PayPal execution status.</p>
              </div>
              <div className="decisions">
                {loading ? (
                  <div className="empty-state"><p>Loading payment decisions…</p></div>
                ) : payments.length === 0 ? (
                  <div className="empty-state"><p>No payments yet.</p></div>
                ) : (
                  payments.map((p) => {
                    const isPending = p.decision === 'MANUAL_APPROVAL_REQUIRED' && p.humanDecision === 'PENDING'
                    const statusClass = p.decision === 'AUTO_APPROVED' ? 'approved' : p.decision === 'REJECTED' ? 'rejected' : 'pending'
                    return (
                      <div key={p._id} className={`decision-card ${statusClass}`}>
                        <div className="decision-header">
                          <div className="decision-agent">{p.agentName}</div>
                          <span className={`badge badge-${p.decision}`}>{p.decision.replace(/_/g, ' ')}</span>
                        </div>
                        <div className="decision-body">
                          <div className="amount-row">
                            <span className="amount">{fmtMoney(p.amount, p.currency)}</span>
                            <span className="category-pill">{p.category || '—'}</span>
                          </div>
                          {p.originalCurrency && p.originalAmount != null && (
                            <p className="conversion-detail">
                              Entered {fmtMoney(p.originalAmount, p.originalCurrency)}
                              {p.exchangeRate ? ` · 1 ${p.originalCurrency} = ${p.exchangeRate.toFixed(6)} ${p.currency}` : ''}
                            </p>
                          )}
                          <div className="decision-meta">
                            <div className="meta-item">
                              <span className="meta-label">Risk score</span>
                              <span className="meta-value" style={{ color: (p.riskScore ?? 0) > 60 ? '#fb7185' : (p.riskScore ?? 0) > 30 ? '#fbbf24' : '#34d399' }}>{p.riskScore ?? '—'}</span>
                            </div>
                            <div className="meta-item">
                              <span className="meta-label">Intent match</span>
                              <span className="meta-value">{p.intentMatch === true ? 'Yes' : p.intentMatch === false ? 'No' : '—'}</span>
                            </div>
                            <div className="meta-item">
                              <span className="meta-label">Autonomy allowed</span>
                              <span className="meta-value">{p.autoSpendLimit == null ? '—' : fmtMoney(p.autoSpendLimit, p.currency)}</span>
                            </div>
                            <div className="meta-item">
                              <span className="meta-label">PayPal status</span>
                              <span className="meta-value">{p.paypalStatus || '—'}</span>
                            </div>
                          </div>
                          {p.paypalError && (
                            <p className={`paypal-message ${p.paypalStatus === 'FAILED' ? 'failed' : ''}`}>
                              {p.paypalError}
                            </p>
                          )}
                          {p.paypalStatus === 'COMPLETED' && p.paypalCaptureId && (
                            <p className="paypal-message">PayPal capture reference: {p.paypalCaptureId}</p>
                          )}
                          {(p.redFlags || []).length > 0 && (
                            <div className="red-flags">
                              <span className="label">Red flags</span>
                              {(p.redFlags).map((f, i) => <span key={i} className="flag">{f}</span>)}
                            </div>
                          )}
                          <p className="decision-reason">{p.decisionReason || p.decision}</p>
                        </div>
                        <div className="decision-actions">
                          {!p.paypalOrderId && p.paypalStatus !== 'COMPLETED' && !p.paypalCaptureId && (
                            <button
                              className="btn ghost btn-sm"
                              type="button"
                              onClick={() => openPaymentEditor(p)}
                              disabled={!!busyPaymentId}
                            >
                              Edit transaction
                            </button>
                          )}
                          {p.paypalLink && p.paypalStatus !== 'COMPLETED' && (
                            <a className="btn primary" href={p.paypalLink} target="_blank" rel="noreferrer">
                              Continue to PayPal
                            </a>
                          )}
                          {p.paypalOrderId && p.paypalStatus !== 'COMPLETED' && (
                            <button
                              className="btn ghost btn-sm"
                              type="button"
                              onClick={() => refreshPayPalStatus(p._id)}
                              disabled={!!busyPaymentId}
                            >
                              {busyPaymentId === p._id ? 'Checking…' : 'Check payment status'}
                            </button>
                          )}
                          {p.paypalOrderId && p.paypalStatus === 'APPROVED' && (
                            <button
                              className="btn primary"
                              type="button"
                              onClick={() => capturePayPalPayment(p._id)}
                              disabled={!!busyPaymentId}
                            >
                              {busyPaymentId === p._id ? 'Capturing…' : 'Capture payment'}
                            </button>
                          )}
                          {p.paypalStatus === 'FAILED' && p.humanDecision === 'APPROVED' && (
                            <button
                              className="btn secondary"
                              type="button"
                              onClick={() => retryPayPalOrder(p._id)}
                              disabled={!!busyPaymentId}
                            >
                              {busyPaymentId === p._id ? 'Retrying…' : 'Retry Checkout'}
                            </button>
                          )}
                          {isPending ? (
                            <>
                              <button className="btn primary" type="button" onClick={() => approvePayment(p._id)} disabled={!!busyPaymentId}>
                                {busyPaymentId === p._id ? 'Processing…' : 'Approve'}
                              </button>
                              <button className="btn danger" type="button" onClick={() => rejectPayment(p._id)} disabled={!!busyPaymentId}>
                                {busyPaymentId === p._id ? 'Processing…' : 'Reject'}
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn ghost btn-sm"
                              type="button"
                              onClick={() => {
                                setSelectedAgentId(p.agentId)
                                document.getElementById('trust-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                              }}
                            >
                              View agent trust
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </section>
          </main>
        </div>
      </div>

      <section className="bottom-zone" id="activity">
        <div className="card audit-section">
          <div className="card-header">
            <h2>Trust history &amp; audit trail</h2>
            <p className="muted">Every AI decision, human action, and PayPal event.</p>
          </div>
          <div className="audit-stats">
            <div className="audit-stat"><span className="stat-value" style={{ color: ringColor(score) }}>{score == null ? '—' : score}</span><span className="stat-label">Trust score</span></div>
            <div className="audit-stat"><span className="stat-value">{apct == null ? '—' : apct}%</span><span className="stat-label">Autonomy</span></div>
            <div className="audit-stat"><span className="stat-value">{selectedAgent ? fmtMoney(selectedAgent.mandateLimit * (apct / 100), currency) : '—'}</span><span className="stat-label">Auto-spend limit</span></div>
            <div className="audit-stat"><span className="stat-value">{selectedAgent ? fmtMoney(selectedAgent.mandateLimit, currency) : '—'}</span><span className="stat-label">Mandate limit</span></div>
          </div>
          <div className="timeline">
            <div className="timeline-section">
              <h3 className="timeline-title">Recent payments</h3>
              <ul className="timeline-list">
                {trustForSelectedAgent && trustForSelectedAgent.recentPayments ? (
                  trustForSelectedAgent.recentPayments.map((p) => (
                    <li key={p._id} className="timeline-item">
                      <span className="time">{new Date(p.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="text">{p.decision.replace(/_/g, ' ')} — {fmtMoney(p.amount, p.currency)} ({p.category || '—'})</span>
                    </li>
                  ))
                ) : (
                  <li className="timeline-item empty"><span className="text">Select an agent to view recent payments.</span></li>
                )}
              </ul>
            </div>
            <div className="timeline-section">
              <h3 className="timeline-title">Decision logs</h3>
              <ul className="timeline-list">
                {trustForSelectedAgent && trustForSelectedAgent.recentLogs ? (
                  trustForSelectedAgent.recentLogs.map((l) => (
                    <li key={l.createdAt} className="timeline-item">
                      <span className="time">{new Date(l.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="actor mono">[{l.actor}]</span>
                      <span className="text">{l.action}: {l.reason}</span>
                    </li>
                  ))
                ) : (
                  <li className="timeline-item empty"><span className="text">Decision events will appear after your first request.</span></li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {showRegister && (
        <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget && !registeringAgent) setShowRegister(false) }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="register-title" onClick={(e) => e.stopPropagation() }>
            <div className="dialog-header">
              <h2 id="register-title">Register new agent</h2>
              <button className="dialog-close" type="button" onClick={() => setShowRegister(false)} aria-label="Close" disabled={registeringAgent}>×</button>
            </div>
            <div className="dialog-body">
              <form onSubmit={createAgent} className="control-form">
                <div className="field">
                  <label className="field-label" htmlFor="agent-name">Name</label>
                  <input className="input" id="agent-name" name="name" placeholder="Agent name" required />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="agent-owner-email">Owner email</label>
                  <input className="input" id="agent-owner-email" name="ownerEmail" type="email" placeholder="owner@example.com" required />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="agent-mandate-limit">Mandate limit</label>
                  <input className="input" id="agent-mandate-limit" name="mandateLimit" type="number" min="0.01" step="0.01" placeholder="0.00" required />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="agent-transaction-limit">Per-transaction limit</label>
                  <input className="input" id="agent-transaction-limit" name="perTransactionLimit" type="number" min="0.01" step="0.01" placeholder="0.00" required />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="agent-allowed-categories">Allowed categories (comma-separated)</label>
                  <input className="input" id="agent-allowed-categories" name="allowedCategories" defaultValue="software,cloud" placeholder="software, cloud" />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="agent-blocked-categories">Blocked categories (comma-separated)</label>
                  <input className="input" id="agent-blocked-categories" name="blockedCategories" defaultValue="" placeholder="e.g. gambling" />
                </div>
                <div className="dialog-actions">
                  <button className="btn secondary" type="button" onClick={() => setShowRegister(false)} disabled={registeringAgent}>Cancel</button>
                  <button className="btn primary" type="submit" disabled={registeringAgent}>{registeringAgent ? 'Registering…' : 'Register'}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
      {editingPayment && (
        <div
          className="dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget && !savingPaymentEdit) setEditingPayment(null)
          }}
        >
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="edit-payment-title">
            <div className="dialog-header">
              <h2 id="edit-payment-title">Edit transaction</h2>
              <button
                className="dialog-close"
                type="button"
                onClick={() => setEditingPayment(null)}
                aria-label="Close"
                disabled={savingPaymentEdit}
              >×</button>
            </div>
            <div className="dialog-body">
              <p className="muted">Editing recalculates the currency conversion and reruns risk and agent policy checks.</p>
              <form onSubmit={savePaymentEdit} className="control-form">
                <div className="field">
                  <label className="field-label" htmlFor="edit-recipient-email">Customer email</label>
                  <input
                    className="input"
                    id="edit-recipient-email"
                    type="email"
                    value={editingPayment.recipientEmail}
                    onChange={(e) => setEditingPayment((current) => ({ ...current, recipientEmail: e.target.value }))}
                    required
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="edit-payment-amount">Amount</label>
                  <div className="edit-currency-row">
                    <input
                      className="input"
                      id="edit-payment-amount"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={editingPayment.amount}
                      onChange={(e) => {
                        setEditingPayment((current) => ({ ...current, amount: e.target.value }))
                        setEditQuote(null)
                        setEditQuoteError('')
                        setEditQuoteLoading(false)
                      }}
                      required
                    />
                    <input
                      className="input"
                      aria-label="Source currency code"
                      title="Enter a three-letter currency code, such as INR or EUR"
                      value={editingPayment.sourceCurrency}
                      onChange={(e) => {
                        setEditingPayment((current) => ({
                          ...current,
                          sourceCurrency: e.target.value.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase(),
                        }))
                        setEditQuote(null)
                        setEditQuoteError('')
                        setEditQuoteLoading(false)
                      }}
                      maxLength={3}
                      pattern="[A-Za-z]{3}"
                      required
                    />
                    <select
                      className="input"
                      aria-label="PayPal checkout currency"
                      value={editingPayment.currency}
                      onChange={(e) => {
                        setEditingPayment((current) => ({ ...current, currency: e.target.value }))
                        setEditQuote(null)
                        setEditQuoteError('')
                        setEditQuoteLoading(false)
                      }}
                    >
                      {(paypalConfig?.currencies || ['USD']).map((code) => (
                        <option key={code} value={code}>{code}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="fx-preview" aria-live="polite">
                  {editQuoteLoading && <span>Getting the latest exchange rate…</span>}
                  {!editQuoteLoading && editQuoteError && <span className="fx-error">{editQuoteError}</span>}
                  {!editQuoteLoading && !editQuoteError && hasCurrentEditQuote && (
                    <>
                      <strong>{fmtMoney(editQuote.convertedAmount, editQuote.to)} estimated checkout amount</strong>
                      <span>
                        {editQuote.from === editQuote.to
                          ? 'No conversion required; source and checkout currencies match.'
                          : `1 ${editQuote.from} = ${editQuote.rate.toFixed(6)} ${editQuote.to}${editQuote.rateUpdatedAt ? ` · rate updated ${editQuote.rateUpdatedAt}` : ''}`}
                      </span>
                    </>
                  )}
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="edit-payment-purpose">Purpose</label>
                  <textarea
                    className="input"
                    id="edit-payment-purpose"
                    value={editingPayment.purpose}
                    onChange={(e) => setEditingPayment((current) => ({ ...current, purpose: e.target.value }))}
                    required
                  />
                </div>
                <div className="dialog-actions">
                  <button className="btn secondary" type="button" onClick={() => setEditingPayment(null)} disabled={savingPaymentEdit}>Cancel</button>
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={savingPaymentEdit || editQuoteLoading || !hasCurrentEditQuote || !!editQuoteError}
                  >
                    {savingPaymentEdit ? 'Re-evaluating…' : 'Save and re-evaluate'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export { App as LegacyPaymentDashboard }
export default ProcurementApp
