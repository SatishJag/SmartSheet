import { ActionMenu, type MenuItem } from './ActionMenu'
import { AssetIcon, ASSET_ICON } from './AssetIcon'
import type { AssetType } from './types'

interface Props {
  type: AssetType
  name: string
  /** One short line under the name. */
  meta: string
  favorite: boolean
  onOpen: () => void
  onToggleFavorite: () => void
  menu: MenuItem[]
}

/** A card in the Reports and Dashboards lists: opens the asset, stars it, and has an actions menu. */
export function AssetCard({ type, name, meta, favorite, onOpen, onToggleFavorite, menu }: Props) {
  return (
    <li className="asset-card card lift">
      <button type="button" className="asset-card-main" onClick={onOpen}>
        <span className="sheet-icon pop-icon">
          <AssetIcon name={ASSET_ICON[type]} size={22} />
        </span>
        <span className="sheet-name">{name}</span>{' '}
        <small className="sheet-date">{meta}</small>
      </button>
      <div className="asset-card-actions">
        <button
          type="button"
          className={`btn-icon${favorite ? ' is-starred' : ''}`}
          aria-pressed={favorite}
          aria-label={favorite ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
          title={favorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={onToggleFavorite}
        >
          <AssetIcon name="star" size={18} filled={favorite} />
        </button>
        <ActionMenu label={`Actions for ${name}`} items={menu} />
      </div>
    </li>
  )
}
