/**
 * Regenerate `packages/shared/src/content/enemy-clips.ts` from the baked models.
 *
 * That file's own header has said "REGENERATE after baking new enemy models:
 * read each glTF's animation list rather than editing by hand" since P9-C, and
 * until now there was nothing to run — the instruction was a comment, and a
 * comment is not a command. P12-C baked 23 more enemies, which is exactly the
 * moment a hand-maintained list of what each rig can animate goes quietly
 * wrong: naming a clip a model does not have is silent, the swing still lands
 * and plays nothing.
 *
 * A `.glb` is a 12-byte header then chunks; the first is JSON. The animation
 * names live in `animations[].name`, prefixed by the exporter as
 * `CharacterArmature|<clip>` — the prefix is stripped here so the registry
 * holds the clip names the content actually authors.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'

/** The animation clip names inside one .glb, sorted and de-prefixed. */
export const clipsInGlb = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a .glb');
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const kind = view.getUint32(offset + 4, true);
    if (kind === CHUNK_JSON) {
      const json = JSON.parse(
        Buffer.from(bytes.buffer, bytes.byteOffset + offset + 8, length).toString('utf8'),
      );
      const names = (json.animations ?? [])
        .map((clip) => String(clip.name ?? ''))
        // `CharacterArmature|Idle` → `Idle`. Some rigs use a different armature
        // name, so split on the LAST bar rather than matching one prefix.
        .map((name) => name.slice(name.lastIndexOf('|') + 1))
        .filter((name) => name.length > 0);
      return [...new Set(names)].sort();
    }
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  throw new Error('no JSON chunk in .glb');
};

const HEADER = `/**
 * Which animation clips each baked enemy model actually HAS.
 *
 * This is a fact about the pipeline's output, not a rendering decision: the
 * client's logical mapping (idle → \`Flying_Idle\` for a floater) stays in the
 * client, but "does \`enemies_mushnub\` own a clip called Punch" is one answer
 * both repos need — the panel to refuse an ability that would animate nothing,
 * the game to know what it can play.
 *
 * It matters because the Quaternius bundle rigs its models in three families
 * with NON-interchangeable names: walkers attack with \`Bite_Front\`, floaters
 * with \`Headbutt\`/\`Punch\`, humanoids with \`Punch\`/\`Weapon\`, and the walkers
 * even spell the hit react differently (\`HitRecieve\`). Naming a clip the rig
 * does not have is silent: the swing still lands, it just plays nothing. That
 * shipped once — the P5 Spore Lobber's panic swat asked a mushnub for \`Punch\`.
 *
 * GENERATED — do not edit. Run \`pnpm assets:clips\` after baking enemy models.
 * It reads the animation list out of each \`assets_baked/enemies/*.glb\`, which
 * is the only source that cannot be wrong about what a rig owns.
 */
export const ENEMY_MODEL_CLIPS: Record<string, readonly string[]> = {
`;

export const generateEnemyClips = async (bakedDir, outFile) => {
  const dir = path.join(bakedDir, 'enemies');
  const files = (await readdir(dir)).filter((name) => name.endsWith('.glb')).sort();
  const rows = [];
  for (const file of files) {
    // `mushnub.ab12cd34.glb` → `enemies_mushnub`; the hash is the pipeline's.
    const id = `enemies_${file.split('.')[0]}`;
    rows.push([id, clipsInGlb(await readFile(path.join(dir, file)))]);
  }
  rows.sort(([a], [b]) => a.localeCompare(b));
  const body = rows
    .map(([id, clips]) => `  ${id}: [${clips.map((clip) => `'${clip}'`).join(', ')}],`)
    .join('\n');
  await writeFile(outFile, `${HEADER}${body}\n};\n`);
  return { models: rows.length, clips: rows.reduce((sum, [, list]) => sum + list.length, 0) };
};
