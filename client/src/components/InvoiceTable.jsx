import { useState } from 'react'
import EditModal from './EditModal'

function InvoiceRow({ inv, onRefresh, showToast, onEdit }) {
  const [sending, setSending] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function sendInvoice() {
    setSending(true)
    try {
      const res = await fetch(`/api/invoices/${inv._id}/send`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      showToast('Invoice sent to client!')
      onRefresh()
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      setSending(false)
    }
  }

  async function deleteInvoice() {
    setDeleting(true)
    try {
      const res = await fetch(`/api/invoices/${inv._id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      showToast('Invoice deleted.')
      onRefresh()
    } catch (err) {
      showToast(err.message, 'error')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <tr>
      <td><strong>{inv.clientName}</strong></td>
      <td>{inv.clientEmail}</td>
      <td>{inv.amount.toLocaleString()}</td>
      <td>{inv.currency}</td>
      <td><span className={`badge badge-${inv.status}`}>{inv.status}</span></td>
      <td>{new Date(inv.createdAt).toLocaleDateString()}</td>
      <td>
        <div className="actions">
          {inv.status === 'DRAFT' && (
            <>
              <button className="btn-action btn-send" onClick={sendInvoice} disabled={sending}>
                {sending ? '...' : 'Send'}
              </button>
              <button className="btn-action btn-edit" onClick={() => onEdit(inv)}>
                Edit
              </button>
            </>
          )}
          {confirmDelete ? (
            <>
              <span className="confirm-text">Delete?</span>
              <button className="btn-action btn-confirm-yes" onClick={deleteInvoice} disabled={deleting}>
                {deleting ? '...' : 'Yes'}
              </button>
              <button className="btn-action btn-cancel" onClick={() => setConfirmDelete(false)}>No</button>
            </>
          ) : (
            <button className="btn-action btn-delete" onClick={() => setConfirmDelete(true)}>Delete</button>
          )}
        </div>
      </td>
    </tr>
  )
}

export default function InvoiceTable({ invoices, loading, onRefresh, showToast }) {
  const [editingInvoice, setEditingInvoice] = useState(null)

  return (
    <div className="card">
      <h2>Invoice Dashboard</h2>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Email</th>
            <th>Amount</th>
            <th>Currency</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7} className="empty">Loading...</td></tr>
          ) : invoices.length === 0 ? (
            <tr><td colSpan={7} className="empty">No invoices yet. Create one above.</td></tr>
          ) : (
            invoices.map(inv => (
              <InvoiceRow
                key={inv._id}
                inv={inv}
                onRefresh={onRefresh}
                showToast={showToast}
                onEdit={setEditingInvoice}
              />
            ))
          )}
        </tbody>
      </table>

      {editingInvoice && (
        <EditModal
          invoice={editingInvoice}
          onClose={() => setEditingInvoice(null)}
          onSaved={onRefresh}
          showToast={showToast}
        />
      )}
    </div>
  )
}
