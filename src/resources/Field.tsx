import { useId, type ReactNode } from 'react'

/** A labelled control. The label is a sibling (not a wrapper), so the control's accessible name is just the label text. */
export function Field({ label, className, children }: { label: string; className?: string; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className={className ? `res-fieldbox ${className}` : 'res-fieldbox'}>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </div>
  )
}
