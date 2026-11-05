import { useState } from 'react'

export default function EditModal({ invoice, onClose, onSaved, showToast }) {
  const [form, setForm] = useState({
    clientName:  invoice.clientName,
    clientEmail: invoice.clientEmail,
    description: invoice.description,
    amount:      invoice.amount,
    currency:    invoice.currency,
    dueDate:     invoice.dueDate ? invoice.dueDate.slice(0, 10) : '',
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      const res = await fetch(`/api/invoices/${invoice._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount: parseFloat(form.amount) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      showToast('Invoice updated.')
      onSaved()
      onClose()
    } catch (e) {
      setErr(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
          <h2 style={{ color:'#003087', fontSize:'1rem' }}>Edit Invoice</h2>
          <button onClick={onClose} style={closeBtn}>✕</button>
        </div>

        <div className="fields">
          {[
            { label:'Client Name',  key:'clientName' },
            { label:'Client Email', key:'clientEmail', type:'email' },
            { label:'Description',  key:'description' },
            { label:'Amount',       key:'amount', type:'number' },
            { label:'Currency',     key:'currency' },
            { label:'Due Date',     key:'dueDate', type:'date' },
          ].map(({ label, key, type='text' }) => (
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

        {err && <div className="inline-msg error" style={{ marginTop:12 }}>{err}</div>}

        <div style={{ display:'flex', gap:10, marginTop:16 }}>
          <button className="btn btn-secondary" onClick={save} disabled={saving} style={{ marginTop:0 }}>
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button className="btn" onClick={onClose} style={{ marginTop:0, background:'#eee', color:'#444' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

const overlay = {
  position:'fixed', inset:0, background:'rgba(0,0,0,0.4)',
  display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000,
}
const modal = {
  background:'#fff', borderRadius:10, padding:28,
  width:'100%', maxWidth:540, boxShadow:'0 8px 32px rgba(0,0,0,0.18)',
}
const closeBtn = {
  background:'none', border:'none', fontSize:'1.1rem',
  cursor:'pointer', color:'#888', padding:'2px 6px',
}
