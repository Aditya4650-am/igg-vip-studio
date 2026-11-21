import { useEffect, useRef } from "react";

/**
 * Falling crystal snow.
 *
 * The flakes are the reference art: six arms, two pairs of side branches and a
 * tip accent, drawn once per size into sprites and then drifted, swayed and
 * rotated on a canvas. `variant` only changes how much of it there is:
 *
 * - `scene` is the login background (dense, big flakes, behind the card);
 * - `app` is the dashboard's own light fall (small flakes, sparse, in front of
 *   the panels but under the sticky header and every dialog).
 *
 * Motion respects `prefers-reduced-motion`: flakes are drawn once, still.
 */
export function Snowfall({ variant = "scene" }: { variant?: "scene" | "app" } = {}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const light = variant === "app";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // ---- snowflake sprites -------------------------------------------------
    // One sprite per size and drawn once, so the frame loop only blits. The
    // shape is the reference crystal: six arms, two pairs of side branches and
    // a small tip accent, stroked in white over an ice-blue glow.
    const makeSprite = (size: number) => {
      const px = Math.ceil(size * 2.4);
      const c = document.createElement("canvas");
      c.width = px;
      c.height = px;
      const g = c.getContext("2d");
      if (!g) return c;
      const cx = px / 2;
      const r = size / 2;
      g.translate(cx, cx);
      g.lineCap = "round";
      g.lineJoin = "round";
      g.shadowColor = "rgba(125, 211, 252, 0.95)";
      g.shadowBlur = r * 0.9;

      const arm = () => {
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(0, -r);
        g.stroke();
        // two branch pairs, like the photo's crystal
        for (const [at, len] of [
          [0.46, 0.3],
          [0.72, 0.19],
        ] as const) {
          const y = -r * at;
          for (const s of [-1, 1]) {
            g.beginPath();
            g.moveTo(0, y);
            g.lineTo(s * r * len, y - r * len * 0.92);
            g.stroke();
          }
        }
        // tip accent
        g.beginPath();
        g.arc(0, -r, Math.max(0.6, r * 0.075), 0, Math.PI * 2);
        g.fill();
      };

      for (const [stroke, alpha] of [
        ["rgba(191, 232, 255, 0.55)", 1],
        ["rgba(255, 255, 255, 0.95)", 1],
      ] as const) {
        g.save();
        g.globalAlpha = alpha;
        g.strokeStyle = stroke;
        g.fillStyle = stroke;
        g.lineWidth = Math.max(0.55, r * 0.075);
        for (let i = 0; i < 6; i++) {
          g.save();
          g.rotate((Math.PI / 3) * i);
          arm();
          g.restore();
        }
        g.restore();
        g.shadowBlur = 0;
        g.lineWidth = Math.max(0.4, r * 0.045);
        g.globalAlpha = 0.9;
      }
      return c;
    };

    const SIZES = light ? [5, 7, 9, 12, 16] : [7, 10, 14, 20, 28, 38];
    const sprites = SIZES.map((size) => makeSprite(size));

    type Flake = {
      x: number;
      y: number;
      size: number;
      vy: number;
      vx: number;
      rot: number;
      vr: number;
      alpha: number;
      sway: number;
      phase: number;
    };

    let width = 0;
    let height = 0;
    let dpr = 1;
    let flakes: Flake[] = [];
    let raf = 0;

    const spawn = (top: boolean): Flake => {
      const idx = Math.floor(Math.random() * sprites.length);
      const depth = idx / (sprites.length - 1); // bigger = closer = faster
      return {
        x: Math.random() * width,
        y: top ? -40 - Math.random() * height * 0.4 : Math.random() * height,
        size: idx,
        vy: light ? 6 + depth * 14 + Math.random() * 5 : 9 + depth * 26 + Math.random() * 8,
        vx: (Math.random() - 0.5) * (light ? 5 : 8),
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.6,
        alpha: light ? 0.16 + depth * 0.34 : 0.28 + depth * 0.55,
        sway: light ? 8 + Math.random() * 16 : 10 + Math.random() * 26,
        phase: Math.random() * Math.PI * 2,
      };
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = light
        ? Math.round(Math.min(46, Math.max(18, (width * height) / 34000)))
        : Math.round(Math.min(110, Math.max(36, (width * height) / 16000)));
      flakes = Array.from({ length: count }, () => spawn(false));
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);
      const t = now / 1000;
      for (const f of flakes) {
        const sprite = sprites[f.size] ?? sprites[0];
        if (!sprite) continue;
        const x = f.x + Math.sin(t * 0.6 + f.phase) * f.sway;
        ctx.save();
        ctx.globalAlpha = f.alpha;
        ctx.translate(x, f.y);
        ctx.rotate(f.rot);
        ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
        ctx.restore();
      }
    };

    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      for (const f of flakes) {
        f.y += f.vy * dt;
        f.x += f.vx * dt;
        f.rot += f.vr * dt;
        if (f.y - 40 > height) Object.assign(f, spawn(true));
        if (f.x < -60) f.x = width + 40;
        if (f.x > width + 60) f.x = -40;
      }
      draw(now);
      raf = window.requestAnimationFrame(step);
    };

    resize();
    if (reduced) {
      draw(performance.now());
    } else {
      raf = window.requestAnimationFrame(step);
    }

    // Pointer parallax for the login backdrop: the scene records the position
    // on `main.login-scene` as two numbers and CSS does the rest (card tilt via
    // the independent `rotate` property, so no animation is overridden).
    const scene = canvas.closest(".login-scene") as HTMLElement | null;
    const parallax = !reduced && !!scene && window.matchMedia("(hover: hover)").matches;
    const onPointerMove = (e: PointerEvent) => {
      const r = scene!.getBoundingClientRect();
      if (!r.width || !r.height) return;
      scene!.style.setProperty("--tilt-x", (((e.clientX - r.left) / r.width) * 2 - 1).toFixed(3));
      scene!.style.setProperty("--tilt-y", (((e.clientY - r.top) / r.height) * 2 - 1).toFixed(3));
    };
    const onPointerLeave = () => {
      scene?.style.setProperty("--tilt-x", "0");
      scene?.style.setProperty("--tilt-y", "0");
    };
    if (parallax) {
      scene!.addEventListener("pointermove", onPointerMove);
      scene!.addEventListener("pointerleave", onPointerLeave);
    }

    const onResize = () => {
      resize();
      if (reduced) draw(performance.now());
    };
    window.addEventListener("resize", onResize);

    const onVisibility = () => {
      if (reduced) return;
      if (document.hidden) {
        window.cancelAnimationFrame(raf);
      } else {
        last = performance.now();
        raf = window.requestAnimationFrame(step);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (parallax) {
        scene?.removeEventListener("pointermove", onPointerMove);
        scene?.removeEventListener("pointerleave", onPointerLeave);
      }
    };
  }, [variant]);

  return (
    <canvas
      ref={canvasRef}
      className={light ? "app-snow" : "winter-snow"}
      aria-hidden="true"
    />
  );
}

/**
 * Login dashboard backdrop: layered night sky, aurora, ridge and the dense
 * snow from `Snowfall`. Mounted only inside `main.login-scene`, `aria-hidden`
 * and `pointer-events: none`, so nothing on the page moves.
 */
export function WinterScene() {
  return (
    <div className="winter-scene" aria-hidden="true">
      <div className="winter-sky" />
      <div className="winter-aurora winter-aurora--one" />
      <div className="winter-aurora winter-aurora--two" />
      <div className="winter-stars" />
      <div className="winter-bloom" />
      <div className="winter-bokeh" />
      <div className="winter-lights" />
      <svg className="winter-crystal" viewBox="0 0 200 200" aria-hidden="true">
        <g stroke="rgba(186, 230, 253, 0.85)" strokeWidth="1.35" fill="none" strokeLinecap="round">
          {[0, 60, 120, 180, 240, 300].map((a) => (
            <g key={a} transform={`rotate(${a} 100 100)`}>
              <path d="M100 100 L100 14" />
              <path d="M100 58 L78 36" />
              <path d="M100 58 L122 36" />
              <path d="M100 38 L86 24" />
              <path d="M100 38 L114 24" />
              <path d="M100 14 L93 24 L100 32 L107 24 Z" />
            </g>
          ))}
        </g>
        <circle cx="100" cy="100" r="5" fill="rgba(224, 242, 254, 0.95)" />
      </svg>
      <svg className="winter-ridge" viewBox="0 0 1440 420" preserveAspectRatio="none">
        <defs>
          <linearGradient id="winterRidgeBack" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0b1730" stopOpacity="0.0" />
            <stop offset="0.45" stopColor="#101c3d" stopOpacity="0.85" />
            <stop offset="1" stopColor="#050a16" />
          </linearGradient>
          <linearGradient id="winterRidgeFront" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c9f2ff" stopOpacity="0.40" />
            <stop offset="0.32" stopColor="#38bdf8" stopOpacity="0.20" />
            <stop offset="0.72" stopColor="#0b2a4a" stopOpacity="0.92" />
            <stop offset="1" stopColor="#040814" />
          </linearGradient>
        </defs>
        <path
          d="M0 250 C 160 196 300 236 430 258 C 560 280 660 214 800 206 C 940 198 1040 268 1170 276 C 1290 284 1370 246 1440 232 L 1440 420 L 0 420 Z"
          fill="url(#winterRidgeBack)"
        />
        <path
          d="M0 306 C 150 262 286 300 420 318 C 566 338 690 286 820 282 C 950 278 1058 330 1184 338 C 1300 346 1380 318 1440 306 L 1440 420 L 0 420 Z"
          fill="url(#winterRidgeFront)"
        />
      </svg>
      <div className="winter-haze" />
      <div className="winter-frost" />
      <Snowfall />
      <div className="winter-vignette" />
    </div>
  );
}
