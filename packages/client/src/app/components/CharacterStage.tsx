/**
 * 3D character preview: composed rig on a pedestal, warm key light, drag to
 * rotate, class pose loop. Used by character select and create
 * (docs/design/UI_UX.md §4 dioramas).
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { classById, type Appearance } from '@dawned/shared';
import {
  composeCharacter,
  loadCharacterAssets,
  type ComposedCharacter,
} from '../../world/characters.js';
import { HeldWeapons, handBones, loadWeaponModels } from '../../world/weapon-models.js';

export interface CharacterStageProps {
  appearance: Appearance;
  classId: string;
  /**
   * Baked model refs for what the character holds (roster values). The sheet
   * shows the gear you equipped, not a generic mannequin.
   */
  mainhandModel?: string | null;
  offhandModel?: string | null;
  /** Stage height driver; the canvas fills its parent. */
  className?: string;
}

export const CharacterStage = ({
  appearance,
  classId,
  mainhandModel = null,
  offhandModel = null,
  className,
}: CharacterStageProps): React.JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Serialize the appearance so the effect re-runs only on real changes. */
  const appearanceKey =
    JSON.stringify(appearance) + classId + (mainhandModel ?? '-') + (offhandModel ?? '-');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;

    const scene = new THREE.Scene();

    // Pedestal: a faceted disc catching the shadow.
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.3, 0.14, 10),
      new THREE.MeshLambertMaterial({ color: '#28324a', flatShading: true }),
    );
    pedestal.position.y = -0.07;
    pedestal.receiveShadow = true;
    scene.add(pedestal);

    const key = new THREE.DirectionalLight(0xffe3bb, 2.6);
    key.position.set(2.2, 3.4, 2.6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    scene.add(key);
    // Soft camera-side fill so faces and dark cloth read on the dim backdrop.
    const fill = new THREE.DirectionalLight(0xfff2e0, 1.1);
    fill.position.set(-1.2, 1.6, 3.2);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x8fb8ff, 1.2);
    rim.position.set(-2.5, 2.0, -2.2);
    scene.add(rim);
    scene.add(new THREE.HemisphereLight(0xdce8ff, 0x4a4a42, 1.15));

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    camera.position.set(0, 1.35, 3.4);
    camera.lookAt(0, 0.95, 0);

    const holder = new THREE.Group();
    scene.add(holder);

    let composed: ComposedCharacter | null = null;
    let held: HeldWeapons | null = null;
    let cancelled = false;

    void Promise.all([loadCharacterAssets(), loadWeaponModels()]).then(([assets, weapons]) => {
      if (cancelled) return;
      composed = composeCharacter(assets, appearance);
      if (composed) {
        holder.add(composed.group);
        const pose = classById(classId)?.poseClip ?? 'Idle_Loop';
        if (!composed.play(pose)) composed.play('Idle_Loop');
        // Same hands, same grip as in the world (weapon-models.ts).
        held = new HeldWeapons(weapons, handBones(composed.group));
        held.set('mainhand', mainhandModel);
        held.set('offhand', offhandModel);
      } else {
        // Silhouette fallback: assets not baked yet — never a blank hole.
        const silhouette = new THREE.Mesh(
          new THREE.CapsuleGeometry(0.34, 1.1, 4, 8),
          new THREE.MeshLambertMaterial({ color: '#3a4356', flatShading: true }),
        );
        silhouette.position.y = 0.9;
        holder.add(silhouette);
      }
    });

    // Drag to rotate; slow idle turntable otherwise.
    let dragging = false;
    let lastX = 0;
    let userYaw = 0;
    const onDown = (event: PointerEvent): void => {
      dragging = true;
      lastX = event.clientX;
    };
    const onMove = (event: PointerEvent): void => {
      if (!dragging) return;
      userYaw += (event.clientX - lastX) * 0.012;
      lastX = event.clientX;
    };
    const onUp = (): void => {
      dragging = false;
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    const resize = (): void => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const { clientWidth, clientHeight } = parent;
      renderer.setSize(clientWidth, clientHeight, false);
      camera.aspect = clientWidth / Math.max(1, clientHeight);
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (canvas.parentElement) observer.observe(canvas.parentElement);

    let lastFrameAt = performance.now();
    let raf = 0;
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastFrameAt) / 1000); // clamp tab-return jumps
      lastFrameAt = now;
      if (!dragging) userYaw += dt * 0.25;
      holder.rotation.y = userYaw;
      composed?.mixer.update(dt);
      renderer.render(scene, camera);
    };
    frame();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      held?.dispose();
      composed?.dispose();
      renderer.dispose();
    };
  }, [appearanceKey]); // eslint-disable-line react-hooks/exhaustive-deps -- appearance is captured via its serialized key

  return (
    <div className={`stage ${className ?? ''}`}>
      <canvas ref={canvasRef} />
    </div>
  );
};
