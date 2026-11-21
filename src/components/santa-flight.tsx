/**
 * Santa's sleigh crossing the login sky, left to right.
 *
 * Drawn as an SVG (no external asset): a red-and-gold sleigh with a wreath and
 * gifts, Santa in his suit with a raised arm, three reindeer in stepped depth
 * with antlers and a warm rim light, trailing sparks. The whole group sweeps
 * across once every ~46 s and bobs gently on its own.
 *
 * Login only. `aria-hidden`, `pointer-events: none`, behind the sign-in card
 * (the card paints later in the document), and still under
 * `prefers-reduced-motion`.
 */
export function SantaFlight() {
  const reindeer = (x: number, y: number, s: number, delay: string, opacity: number) => (
    <g transform={`translate(${x} ${y}) scale(${s})`} opacity={opacity} style={{ animationDelay: delay }}>
      {/* body */}
      <path
        d="M0 44 C 4 32, 18 28, 30 30 C 42 32, 52 38, 54 48 C 56 58, 48 64, 36 64 C 22 64, 2 58, 0 44 Z"
        fill="url(#santaHide)"
        stroke="rgba(255, 214, 160, 0.45)"
        strokeWidth="1.1"
      />
      {/* neck + head */}
      <path d="M46 40 C 54 30, 58 22, 60 14 L 66 12 C 68 20, 64 34, 56 46 Z" fill="url(#santaHide)" />
      <path d="M58 8 C 66 4, 74 6, 78 12 C 82 18, 80 24, 74 26 C 68 28, 60 24, 58 18 Z" fill="url(#santaHide)" />
      {/* muzzle + ear */}
      <path d="M76 13 L 86 15 L 84 20 L 76 20 Z" fill="#0a1428" />
      <path d="M66 9 C 70 3, 74 2, 77 6 C 74 10, 70 11, 66 9 Z" fill="#0a1428" />
      {/* antlers */}
      <g stroke="rgba(255, 226, 170, 0.75)" strokeWidth="1.6" fill="none" strokeLinecap="round">
        <path d="M64 8 C 62 0, 56 -4, 50 -6" />
        <path d="M60 2 C 54 0, 50 2, 47 5" />
        <path d="M68 6 C 70 -2, 76 -6, 82 -8" />
        <path d="M72 0 C 78 -2, 82 0, 85 3" />
      </g>
      {/* legs tucked */}
      <g stroke="url(#santaHide)" strokeWidth="5" strokeLinecap="round">
        <path d="M14 60 C 8 68, 6 76, 8 82" />
        <path d="M30 62 C 26 72, 26 80, 30 86" />
        <path d="M44 62 C 42 72, 44 80, 50 84" />
      </g>
      {/* harness + bell */}
      <path d="M30 32 C 38 40, 46 42, 54 40" stroke="#c8102e" strokeWidth="2.4" fill="none" />
      <circle cx="34" cy="36" r="2.2" fill="#f6c65b" />
    </g>
  );

  return (
    <div className="santa-flight" aria-hidden="true">
      <svg className="santa-flight-svg" viewBox="0 0 560 260" fill="none">
        <defs>
          <linearGradient id="santaHide" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#243a5e" />
            <stop offset="0.55" stopColor="#16233d" />
            <stop offset="1" stopColor="#0a1326" />
          </linearGradient>
          <linearGradient id="santaSleigh" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d7263d" />
            <stop offset="0.55" stopColor="#a3122a" />
            <stop offset="1" stopColor="#6d0a1a" />
          </linearGradient>
          <linearGradient id="santaGold" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffe6a8" />
            <stop offset="0.5" stopColor="#f0c063" />
            <stop offset="1" stopColor="#b8862c" />
          </linearGradient>
          <radialGradient id="santaGlow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="rgba(255, 224, 168, 0.55)" />
            <stop offset="1" stopColor="rgba(255, 224, 168, 0)" />
          </radialGradient>
          <linearGradient id="santaTrail" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgba(186, 235, 255, 0)" />
            <stop offset="0.6" stopColor="rgba(186, 235, 255, 0.55)" />
            <stop offset="1" stopColor="rgba(255, 232, 170, 0.75)" />
          </linearGradient>
        </defs>

        {/* warm aura behind the sleigh */}
        <ellipse cx="250" cy="150" rx="210" ry="86" fill="url(#santaGlow)" />

        {/* reins */}
        <path d="M196 150 C 236 132, 268 126, 300 132" stroke="rgba(255, 214, 160, 0.55)" strokeWidth="1.6" fill="none" />
        <path d="M204 158 C 244 146, 276 142, 306 148" stroke="rgba(255, 214, 160, 0.35)" strokeWidth="1.2" fill="none" />

        {/* reindeer, far to near */}
        {reindeer(352, 66, 0.72, "0s", 0.55)}
        {reindeer(304, 82, 0.84, "0.4s", 0.72)}
        {reindeer(250, 98, 1, "0.8s", 0.95)}

        {/* sleigh */}
        <g className="santa-sleigh">
          {/* runner */}
          <path
            d="M52 196 C 46 214, 58 228, 88 232 L 214 232 C 232 232, 240 224, 236 214"
            stroke="url(#santaGold)"
            strokeWidth="4.5"
            strokeLinecap="round"
            fill="none"
          />
          <path d="M74 196 L 74 214 M 196 196 L 196 214" stroke="url(#santaGold)" strokeWidth="2.6" strokeLinecap="round" />
          {/* body */}
          <path
            d="M44 150 C 44 136, 58 128, 82 128 L 196 128 C 210 128, 218 138, 216 152 L 210 196 C 208 208, 198 214, 184 214 L 80 214 C 62 214, 48 204, 46 188 Z"
            fill="url(#santaSleigh)"
            stroke="rgba(255, 210, 150, 0.5)"
            strokeWidth="1.4"
          />
          {/* gold trim + panel */}
          <path d="M52 176 C 96 188, 168 188, 208 176" stroke="url(#santaGold)" strokeWidth="2.2" fill="none" />
          <path d="M54 150 C 96 158, 168 158, 210 150" stroke="rgba(255, 232, 180, 0.35)" strokeWidth="1.2" fill="none" />
          {/* wreath */}
          <circle cx="116" cy="178" r="15" stroke="#1f7a44" strokeWidth="5" fill="none" />
          <circle cx="116" cy="178" r="15" stroke="#2f9a58" strokeWidth="2" fill="none" strokeDasharray="3 4" />
          <path d="M110 190 q 6 8 12 0" stroke="#c8102e" strokeWidth="2.4" fill="none" strokeLinecap="round" />
          {/* gifts inside */}
          <g>
            <rect x="76" y="112" width="26" height="20" rx="3" fill="#2f6fd0" stroke="#bbd8ff" strokeWidth="1" />
            <path d="M89 112 v20 M76 122 h26" stroke="#ffe6a8" strokeWidth="1.6" />
            <rect x="140" y="108" width="22" height="18" rx="3" fill="#c8102e" stroke="#ffd9a0" strokeWidth="1" />
            <path d="M151 108 v18 M140 117 h22" stroke="#ffe6a8" strokeWidth="1.4" />
            <rect x="168" y="114" width="18" height="16" rx="3" fill="#2f9a58" stroke="#d6ffe8" strokeWidth="1" />
            <path d="M177 114 v16 M168 122 h18" stroke="#ffe6a8" strokeWidth="1.3" />
            {/* little tree */}
            <path d="M108 110 l 11 -20 l 11 20 z" fill="#1f7a44" stroke="#39b56a" strokeWidth="1" />
            <rect x="117" y="110" width="4" height="6" fill="#8b5e34" />
          </g>
          {/* lantern */}
          <path d="M206 160 l 10 0 l 0 14 l -10 0 z" fill="rgba(255, 214, 140, 0.85)" />
          <circle cx="211" cy="167" r="12" fill="url(#santaGlow)" />

          {/* Santa */}
          <g className="santa-figure">
            {/* body */}
            <path d="M96 128 C 96 108, 110 96, 126 96 C 142 96, 152 110, 150 128 Z" fill="#c8102e" stroke="#ffd9a0" strokeWidth="1.1" />
            {/* belt */}
            <path d="M100 122 h 46" stroke="#161616" strokeWidth="6" />
            <rect x="118" y="118" width="10" height="9" rx="1.6" fill="url(#santaGold)" />
            {/* arm raised */}
            <path d="M142 108 C 152 96, 162 92, 170 94" stroke="#c8102e" strokeWidth="9" strokeLinecap="round" fill="none" />
            <circle cx="172" cy="93" r="5.2" fill="#f2d0b0" />
            {/* beard + face */}
            <circle cx="124" cy="88" r="12" fill="#f2d0b0" />
            <path d="M112 90 C 112 104, 136 106, 136 90 C 132 98, 118 98, 112 90 Z" fill="#f7f7fb" />
            <circle cx="129" cy="86" r="1.5" fill="#233" />
            <circle cx="120" cy="86" r="1.5" fill="#233" />
            {/* hat */}
            <path d="M110 82 C 112 70, 130 66, 138 74 C 142 78, 142 82, 140 84 Z" fill="#c8102e" stroke="#ffd9a0" strokeWidth="1" />
            <path d="M108 82 C 116 78, 132 78, 141 83" stroke="#f7f7fb" strokeWidth="4" strokeLinecap="round" fill="none" />
            <circle cx="142" cy="72" r="5" fill="#f7f7fb" />
          </g>
        </g>

        {/* sparkle trail */}
        <g className="santa-sparks" fill="url(#santaTrail)">
          <rect x="18" y="182" width="62" height="2.2" rx="1.1" />
          <rect x="6" y="196" width="42" height="1.8" rx="0.9" />
          <rect x="26" y="170" width="34" height="1.6" rx="0.8" />
          <circle cx="90" cy="150" r="2.1" opacity="0.8" />
          <circle cx="60" cy="132" r="1.5" opacity="0.6" />
          <circle cx="34" cy="120" r="1.1" opacity="0.5" />
        </g>
      </svg>
    </div>
  );
}
