const fs = require("fs");
const path = "src/styles.css";
let css = fs.readFileSync(path, "utf8");

// Map of the EXACT mojibake byte-sequences (as they appear in the UTF-8 text)
// to the correct emoji. These were UTF-8 emojis double-decoded as CP1252.
const fixes = [
  // selector-anchored replacements to avoid collisions
  { sel: ".sidebar-device-block > .kicker::before", wrong: "ðŸ–¥ï¸\u008f", right: "🖥️" },  // 🖥️ desktop
  { sel: ".sidebar-tools > .kicker::before",        wrong: "âš¡",        right: "⚡" },   // ⚡ lightning
  { sel: ".sidebar-log > .kicker::before",          wrong: "ðŸ"‹",        right: "📋" },   // 📋 clipboard
  { sel: ".state-badge--ready::before",             wrong: "âœ“",        right: "✓" },    // ✓ check
  { sel: ".state-badge--season::before",            wrong: "âœ¦",        right: "✦" },    // ✦ star
  { sel: ".state-badge--regatta::before",           wrong: "â›µ",        right: "⛵" },    // ⛵ sailboat
];

// Generic replace: for each selector, find its `content: "..."` line and swap the emoji.
let changed = 0;
for (const f of fixes) {
  // find the selector, then within its block replace the first content:"..."
  const idx = css.indexOf(f.sel);
  if (idx === -1) { console.log("SELECTOR NOT FOUND:", f.sel); continue; }
  const blockEnd = css.indexOf("}", idx);
  const block = css.slice(idx, blockEnd);
  const newBlock = block.replace(/content:\s*"[^"]*"/, `content: "${f.right}"`);
  if (newBlock !== block) {
    css = css.slice(0, idx) + newBlock + css.slice(blockEnd);
    changed++;
    console.log("FIXED:", f.sel, "->", f.right);
  }
}

fs.writeFileSync(path, Buffer.from(css, "utf8"));

// validate brace depth
let d = 0;
for (const c of css) { if (c === "{") d++; else if (c === "}") d--; }
console.log("changed:", changed, "depth:", d);

// Verify no mojibake remains in content lines
const lines = css.split("\n");
let left = 0;
lines.forEach((l, i) => {
  if (/[\u0080-\u00FF]/.test(l) && /content:/.test(l)) { console.log("STILL BROKEN line", i + 1, ":", l.trim()); left++; }
});
console.log("remaining mojibake content lines:", left);
