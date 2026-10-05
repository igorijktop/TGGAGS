import { useEffect, useState } from 'react'
import type { AssetMeta } from '@shared/media'
import { api, onEvent } from '../../lib/api'
import { toFileUrl } from '../../lib/util'

const urlCache = new Map<string, Promise<string>>()
export function assetUrl(id: string): Promise<string> {
  let p = urlCache.get(id)
  if (!p) { p = api.images.assetPath(id).then(toFileUrl); urlCache.set(id, p) }
  return p
}

export function useAssetUrl(id: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => { let dead = false; setUrl(null); if (id) void assetUrl(id).then(u => { if (!dead) setUrl(u) }).catch(() => undefined); return () => { dead = true } }, [id])
  return url
}

export function useAssets(): { assets: AssetMeta[]; reload(): void } {
  const [assets, setAssets] = useState<AssetMeta[]>([])
  const reload = () => void api.images.listAssets().then(a => setAssets([...a].sort((x, y) => y.createdAt - x.createdAt))).catch(() => undefined)
  useEffect(() => { reload(); return onEvent('assets:changed', reload) }, [])
  return { assets, reload }
}

export function Thumb({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const url = useAssetUrl(id)
  return url ? <img className={className} src={url} alt={alt} loading="lazy" draggable={false} /> : <div className={`${className ?? ''} skeleton`} />
}
