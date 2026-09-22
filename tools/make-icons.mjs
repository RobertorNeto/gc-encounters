/**
 * Gera os ícones da extensão em src/icons/. Sem dependência de imagem: escreve o
 * PNG na mão (IHDR + IDAT + IEND) e desenha o símbolo por matemática de pixel.
 *
 * Símbolo: anel laranja com uma abertura e uma ponta de seta — o "🔁" do reencontro.
 * Renderizado com supersampling 4x para não ficar serrilhado nos 16px.
 *
 *   node tools/make-icons.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'src/icons');

const BG = [19, 22, 28, 255]; // #13161c, a superfície da página de opções
const FG = [245, 165, 36, 255]; // #f5a524, o âmbar do acento

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filtro "none"
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Cor do ponto (x, y) em coordenadas 0..1, ou null para transparente. */
function sample(x, y) {
  const cx = x - 0.5;
  const cy = y - 0.5;

  // Fundo: quadrado de cantos arredondados.
  const corner = 0.22;
  const dx = Math.max(Math.abs(cx) - (0.5 - corner), 0);
  const dy = Math.max(Math.abs(cy) - (0.5 - corner), 0);
  if (Math.hypot(dx, dy) > corner) return null;

  const r = Math.hypot(cx, cy);
  const angle = Math.atan2(cy, cx); // -PI..PI

  // Anel com abertura no canto superior direito.
  const inner = 0.19;
  const outer = 0.3;
  const gapFrom = -1.25;
  const gapTo = -0.15;
  const inRing = r >= inner && r <= outer;
  const inGap = angle > gapFrom && angle < gapTo;
  if (inRing && !inGap) return FG;

  // Ponta de seta fechando a volta, na borda da abertura.
  const tipAngle = gapTo;
  const tx = Math.cos(tipAngle) * ((inner + outer) / 2);
  const ty = Math.sin(tipAngle) * ((inner + outer) / 2);
  if (Math.hypot(cx - tx, cy - ty) <= 0.1) return FG;

  return BG;
}

async function render(size) {
  const ss = 4; // supersampling
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += c[3];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      // Pre-multiplicado pela cobertura: borda transparente sem halo escuro.
      pixels[i] = a ? Math.round(r / (a / 255)) : 0;
      pixels[i + 1] = a ? Math.round(g / (a / 255)) : 0;
      pixels[i + 2] = a ? Math.round(b / (a / 255)) : 0;
      pixels[i + 3] = Math.round(a / n);
    }
  }
  const file = path.join(outDir, `icon${size}.png`);
  await writeFile(file, png(size, pixels));
  console.log(`icon${size}.png`);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) await render(size);
