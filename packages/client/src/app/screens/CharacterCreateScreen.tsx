/**
 * Character creation: class carousel with the rig posing live, then the look —
 * body, skin, outfit + tint, hair + color, beard — all on the 3D model, then the
 * name (docs/design/UI_UX.md §4, Q13 decisions).
 */

import { useMemo, useState } from 'react';
import {
  CLASSES,
  DEFAULT_APPEARANCE,
  HAIRSTYLES,
  HAIR_COLORS,
  OUTFITS,
  SKIN_TONES,
  characterNameSchema,
  type Appearance,
  type BodyId,
  type ClassId,
  type OutfitId,
} from '@dawned/shared';
import { useApp } from '../store.js';
import { Backdrop } from '../components/Backdrop.js';
import { CharacterStage } from '../components/CharacterStage.js';
import { Button, ChipRow, ErrorLine, Panel, SwatchRow, TextField } from '../components/ui.js';

const randomOf = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

export const CharacterCreateScreen = (): React.JSX.Element => {
  const { createCharacter, enterWorld, goTo, busy, error } = useApp();
  const [classId, setClassId] = useState<ClassId>('warrior');
  const [appearance, setAppearance] = useState<Appearance>({ ...DEFAULT_APPEARANCE });
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const set = <K extends keyof Appearance>(key: K, value: Appearance[K]): void => {
    setAppearance((current) => ({ ...current, [key]: value }));
  };

  const outfit = useMemo(
    () => OUTFITS.find((entry) => entry.id === appearance.outfit) ?? OUTFITS[0]!,
    [appearance.outfit],
  );

  const rollRandom = (): void => {
    setAppearance({
      body: randomOf(['m', 'f'] as const),
      skin: Math.floor(Math.random() * SKIN_TONES.length),
      outfit: randomOf(OUTFITS).id,
      outfitTint: Math.floor(Math.random() * outfit.tints.length),
      hair: randomOf(HAIRSTYLES).id,
      hairColor: Math.floor(Math.random() * HAIR_COLORS.length),
      beard: Math.random() < 0.25,
    });
  };

  const submit = (): void => {
    setLocalError(null);
    const check = characterNameSchema.safeParse(name.trim());
    if (!check.success) {
      setLocalError(check.error.issues[0]?.message ?? 'Invalid name.');
      return;
    }
    void createCharacter({ name: name.trim(), classId, appearance }).then((character) => {
      if (character) enterWorld(character);
    });
  };

  return (
    <div className="screen">
      <Backdrop />
      <div className="screen__scrim screen__scrim--heavy" />

      <div className="create-layout">
        {/* Class carousel */}
        <Panel className="create-classes">
          <div className="panel__title">CLASS</div>
          {CLASSES.map((cls) => (
            <button
              key={cls.id}
              className={`class-card${classId === cls.id ? ' is-selected' : ''}`}
              style={{ ['--accent' as never]: cls.color }}
              onClick={() => {
                setClassId(cls.id);
              }}
            >
              <span className="class-card__name">{cls.name}</span>
              <span className="class-card__meta">
                {cls.archetype} · {cls.resource}
              </span>
              <span className="class-card__tagline">{cls.tagline}</span>
            </button>
          ))}
        </Panel>

        {/* Living preview */}
        <div className="create-stage">
          <CharacterStage appearance={appearance} classId={classId} />
          <div className="create-stage__hint">drag to turn</div>
        </div>

        {/* Look + name */}
        <Panel className="create-look">
          <div className="panel__title">
            APPEARANCE
            <button className="dice" onClick={rollRandom} title="Randomize" type="button">
              ⚄
            </button>
          </div>

          <ChipRow
            label="Body"
            options={[
              { id: 'm', name: 'Male' },
              { id: 'f', name: 'Female' },
            ]}
            selected={appearance.body}
            onSelect={(id: BodyId) => {
              set('body', id);
            }}
          />
          <SwatchRow
            label="Skin tone"
            colors={SKIN_TONES}
            selected={appearance.skin}
            onSelect={(index) => {
              set('skin', index);
            }}
          />
          <ChipRow
            label="Outfit"
            options={OUTFITS.map((entry) => ({ id: entry.id, name: entry.name }))}
            selected={appearance.outfit}
            onSelect={(id: OutfitId) => {
              set('outfit', id);
              set('outfitTint', 0);
            }}
          />
          <SwatchRow
            label="Outfit tint"
            colors={outfit.tints}
            selected={appearance.outfitTint}
            onSelect={(index) => {
              set('outfitTint', index);
            }}
          />
          <ChipRow
            label="Hair"
            options={HAIRSTYLES.map((entry) => ({ id: entry.id, name: entry.name }))}
            selected={appearance.hair}
            onSelect={(id) => {
              set('hair', id);
            }}
          />
          <SwatchRow
            label="Hair color"
            colors={HAIR_COLORS}
            selected={appearance.hairColor}
            onSelect={(index) => {
              set('hairColor', index);
            }}
          />
          <ChipRow
            label="Beard"
            options={[
              { id: 'no', name: 'None' },
              { id: 'yes', name: 'Beard' },
            ]}
            selected={appearance.beard ? 'yes' : 'no'}
            onSelect={(id) => {
              set('beard', id === 'yes');
            }}
          />

          <div className="create-name">
            <TextField
              label="Name"
              value={name}
              onChange={setName}
              maxLength={16}
              placeholder="Letters, single spaces"
              hint="2–16 characters. This name is unique across the whole world."
            />
          </div>
          <ErrorLine message={localError ?? error} />
          <div className="create-actions">
            <Button onClick={submit} disabled={busy}>
              {busy ? 'CREATING…' : 'CREATE & ENTER WORLD'}
            </Button>
            <Button
              kind="ghost"
              onClick={() => {
                goTo('select');
              }}
            >
              BACK
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
};
