import { useState } from 'react'

const emptyForm = {
  clientName: '', clientEmail: '', description: '',
  amount: '', currency: 'USD', dueDate: '',
}

export default function InvoiceForm({ onCreated, showToast }) {
  const [prompt, setPrompt] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [showFields, setShowFields] = useState(false)
  const [parseMsg, setParseMsg] = useState(null)
  const [createMsg, setCreateMsg] = useState(null)
  const [parsing, setParsing] = useState(false)
  const [creating, setCreating] = useState(false)

  async function parseInvoice() {
    if (!prompt.trim()) return setParseMsg({ text: 'Please describe your invoice first.', type: 'error' })
    setParsing(true)
    setParseMsg(null)
    try {
      const res = await fetch('/api/invoices/ai/parse-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setForm({
        clientName: data.invoice.clientName || '',
        clientEmail: data.invoice.clientEmail || '',
        description: data.invoice.description || '',
        amount: data.invoice.amount || '',
        currency: data.invoice.currency || 'USD',
        dueDate: data.invoice.dueDate || '',
      })
      setShowFields(true)
      setParseMsg({ text: '✓ Details extracted. Review and click Create.', type: 'success' })
    } catch (err) {
      setParseMsg({ text: err.message, type: 'error' })
    } finally {
      setParsing(false)
    }
  }

  async function createInvoice() {
    setCreating(true)
    setCreateMsg(null)
    try {
      const res = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount: parseFloat(form.amount), aiPrompt: prompt }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setCreateMsg({ text: '✓ Invoice created and saved to PayPal!', type: 'success' })
      showToast('Invoice created successfully!')
      onCreated()
      setForm(emptyForm)
      setShowFields(false)
      setPrompt('')
      setParseMsg(null)
    } catch (err) {
      setCreateMsg({ text: err.message, type: 'error' })
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="card">
      <h2>Create Invoice with AI</h2>
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="e.g. Create an invoice for Rahul at rahul@example.com for website redesign, ₹15,000, due in 7 days."
      />
      <button className="btn btn-primary" onClick={parseInvoice} disabled={parsing}>
        {parsing ? 'Parsing...' : 'Parse with AI'}
      </button>
      {parseMsg && <div className={`inline-msg ${parseMsg.type}`}>{parseMsg.text}</div>}

      {showFields && (
        <>
          <div className="fields">
            {[
              { label: 'Client Name', key: 'clientName' },
              { label: 'Client Email', key: 'clientEmail', type: 'email' },
              { label: 'Description', key: 'description' },
              { label: 'Amount', key: 'amount', type: 'number' },
              { label: 'Currency', key: 'currency' },
              { label: 'Due Date', key: 'dueDate', type: 'date' },
            ].map(({ label, key, type = 'text' }) => (
              <label key={key}>
                {label}
                <input
                  type={type}
                  value={form[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <button className="btn btn-secondary" onClick={createInvoice} disabled={creating}>
            {creating ? 'Creating...' : 'Create PayPal Invoice'}
          </button>
          {createMsg && <div className={`inline-msg ${createMsg.type}`}>{createMsg.text}</div>}
        </>
      )}
    </div>
  )
}
