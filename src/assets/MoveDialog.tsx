import { useId, useMemo, useState } from 'react'
import { destinations, folderMoveTargets, placementOf } from './assetModel'
import { Dialog } from './Dialog'
import type { AssetType } from './types'
import { useAssets, useAssetsApi } from './useAssets'

type Props = { onClose: () => void } & ({ asset: { type: AssetType; id: string; name: string }; folder?: never } | { folder: { id: string; name: string }; asset?: never })

const NONE = ''

/** Moves an asset to a workspace or folder (or out of workspaces), or a folder to another place in its workspace. */
export function MoveDialog({ asset, folder, onClose }: Props) {
  const api = useAssetsApi()
  const workspaces = useAssets((s) => s.workspaces)
  const folders = useAssets((s) => s.folders)
  const placements = useAssets((s) => s.placements)
  const data = useMemo(() => ({ workspaces, folders, placements }), [workspaces, folders, placements])
  const id = useId()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const options = useMemo(
    () => (folder ? folderMoveTargets(data, folder.id) : destinations(data)),
    [data, folder],
  )
  const current = folder
    ? (() => {
        const f = folders.find((x) => x.id === folder.id)
        return f ? `${f.spaceId}|${f.parentId ?? ''}` : NONE
      })()
    : (() => {
        const p = placementOf(data, asset!.type, asset!.id)
        return p ? `${p.spaceId}|${p.folderId ?? ''}` : NONE
      })()
  const [value, setValue] = useState(current)
  const what = folder ? folder.name : asset!.name

  async function move() {
    setBusy(true)
    setError(null)
    const [spaceId, folderId] = value.split('|')
    const res = folder
      ? await api.getState().moveFolder(folder.id, folderId || null)
      : await api.getState().placeAsset(asset!.type, asset!.id, value === NONE ? null : { spaceId, folderId: folderId || null })
    setBusy(false)
    if (res.ok) onClose()
    else setError(res.error)
  }

  return (
    <Dialog
      title={`Move "${what}"`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => void move()} disabled={busy || value === current}>
            Move
          </button>
        </>
      }
    >
      <label htmlFor={id} className="label">
        Move to
      </label>
      <select id={id} value={value} onChange={(e) => setValue(e.target.value)} data-autofocus>
        {!folder && <option value={NONE}>Not in a workspace</option>}
        {options.map((d) => (
          <option key={`${d.spaceId}|${d.folderId ?? ''}`} value={`${d.spaceId}|${d.folderId ?? ''}`}>
            {`${' '.repeat(d.depth)}${d.name}`}
          </option>
        ))}
      </select>
      {options.length === 0 && !folder && <p className="builder-hint">Create a workspace first, then you can move things into it.</p>}
      {error && (
        <p role="alert" className="asset-warn">
          {error}
        </p>
      )}
    </Dialog>
  )
}
