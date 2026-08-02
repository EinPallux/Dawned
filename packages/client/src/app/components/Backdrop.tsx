/**
 * The menu vignette: the real island at dawn, slow camera drift — a living
 * backdrop, not a JPG (docs/design/UI_UX.md §4). One WebGL context, paused when
 * unmounted.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  PALETTE,
  buildLights,
  buildSkyMesh,
  buildTerrainMesh,
  buildWaterMesh,
} from '../../world/environment.js';

export const Backdrop = (): React.JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(new THREE.Color('#e8b98a'), 60, 300);
    scene.add(buildSkyMesh(PALETTE.dawnSkyTop, PALETTE.dawnSkyHorizon));
    scene.add(buildTerrainMesh());
    scene.add(buildWaterMesh());
    const { sun, hemisphere } = buildLights({ warm: true, shadows: false });
    scene.add(sun, hemisphere);

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);

    const resize = (): void => {
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    const start = performance.now();
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const t = (performance.now() - start) / 1000;
      // Slow drift around the island, gently bobbing — dawn patrol.
      const angle = t * 0.03;
      camera.position.set(
        Math.sin(angle) * 55,
        14 + Math.sin(t * 0.11) * 1.5,
        Math.cos(angle) * 55,
      );
      camera.lookAt(0, 5, 0);
      renderer.render(scene, camera);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="backdrop" aria-hidden />;
};
