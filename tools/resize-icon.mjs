/**
 * Converte src/icons/source.png nos tamanhos que a extensão usa.
 *
 * Decodifica e redimensiona na mão (zlib + média de área), para o projeto seguir
 * sem dependência de biblioteca de imagem. Aceita PNG de 8 bits, RGB ou RGBA, sem
 * entrelaçamento — que é o que qualquer editor gera por padrão.
 *
 *   node tools/resize-icon.mjs
 *
 * Para JPG, o caminho e outro (o decodificador aqui e so de PNG):
 *   powershell -Command "Add-Type -AssemblyName System.Drawing; ..."
 * ou converta o arquivo para PNG antes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'src/icons');
const SIZES = [16, 32, 48, 128];

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

function encodePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** PNG -> { width, height, pixels RGBA }. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('não é um PNG (converta para .png)');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colorType = data[9];
      if (depth !== 8) throw new Error(`PNG de ${depth} bits — reexporte com 8 bits por canal`);
      if (data[12] !== 0) throw new Error('PNG entrelaçado — reexporte sem interlace');
      if (colorType === 2) channels = 3;
      else if (colorType === 6) channels = 4;
      else throw new Error(`PNG do tipo ${colorType} — reexporte como RGB ou RGBA`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    // Desfaz o filtro por linha (spec PNG, seção 9).
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = value & 0xff;
    }
    line.copy(prev);
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src];
      out[dst + 1] = line[src + 1];
      out[dst + 2] = line[src + 2];
      out[dst + 3] = channels === 4 ? line[src + 3] : 255;
    }
  }
  return { width, height, pixels: out };
}

/** Redução por média de área: o que mantém legibilidade em 16px. */
function resize(src, size) {
  const out = Buffer.alloc(size * size * 4);
  const scaleX = src.width / size;
  const scaleY = src.height / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < src.height; sy += 1) {
        for (let sx = x0; sx < x1 && sx < src.width; sx += 1) {
          const i = (sy * src.width + sx) * 4;
          const alpha = src.pixels[i + 3] / 255;
          r += src.pixels[i] * alpha;
          g += src.pixels[i + 1] * alpha;
          b += src.pixels[i + 2] * alpha;
          a += src.pixels[i + 3];
          n += 1;
        }
      }
      const i = (y * size + x) * 4;
      const cover = a / n / 255 || 1;
      out[i] = Math.round(r / n / cover);
      out[i + 1] = Math.round(g / n / cover);
      out[i + 2] = Math.round(b / n / cover);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

const source = path.join(dir, 'source.png');
let file;
try {
  file = await readFile(source);
} catch {
  console.error(`coloque a imagem em ${source} e rode de novo.`);
  process.exit(1);
}

const img = decodePng(file);
console.log(`origem: ${img.width}x${img.height}`);
for (const size of SIZES) {
  await writeFile(path.join(dir, `icon${size}.png`), encodePng(size, resize(img, size)));
  console.log(`icon${size}.png`);
}
