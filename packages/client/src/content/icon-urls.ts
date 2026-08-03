/**
 * Ability/UI icon URLs from the baked manifest (game-icons.net set, recolored
 * for CSS masking — ASSET_PIPELINE.md §4). Content rows reference icons by
 * their `author/name` slug; this resolves slugs to the hashed web files.
 */

interface ManifestIconAsset {
  category?: string;
  file?: string;
  iconSlug?: string;
}

export const loadIconUrls = async (): Promise<Map<string, string>> => {
  const urls = new Map<string, string>();
  try {
    const response = await fetch('/assets/manifest.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = (await response.json()) as { assets?: Record<string, ManifestIconAsset> };
    for (const asset of Object.values(manifest.assets ?? {})) {
      if (asset.category === 'icons' && asset.iconSlug && asset.file) {
        urls.set(asset.iconSlug, `/${asset.file}`);
      }
    }
  } catch (error) {
    // Tiles fall back to text monograms — ugly but never blank.
    console.warn('[content] icon manifest unavailable:', error);
  }
  return urls;
};
