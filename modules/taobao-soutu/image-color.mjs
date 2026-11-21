import sharp from 'sharp';
import { productColors } from './materials.mjs';

const sampleSize = 60;
const minimumReferenceShare = 0.50;
const minimumProductShare = 0.44;
const minimumLead = 0.20;

function pixelColor(red, green, blue) {
  const bright = Math.max(red, green, blue);
  const chroma = bright - Math.min(red, green, blue);
  const saturation = bright ? chroma / bright : 0;
  if (chroma < 5 || saturation < 0.09) {
    if (bright < 65) return '黑色';
    return bright >= 208 ? '白色' : '灰色';
  }
  let hue;
  if (bright === red) hue = (green - blue) / chroma;
  else if (bright === green) hue = 2 + (blue - red) / chroma;
  else hue = 4 + (red - green) / chroma;
  hue = (hue * 60 + 360) % 360;

  // Warm, muted shadows still carry color. Coffee fabrics often fall in this range.
  if ((hue <= 54 || hue >= 315) && bright <= 162 && saturation <= 0.62) return '棕色';
  if (hue >= 32 && hue <= 60 && saturation <= 0.43 && bright > 146) return '卡其色';
  if ((hue <= 22 || hue >= 338) && bright > 162 && saturation < 0.48) return '粉色';
  if (hue < 14 || hue >= 338) return '红色';
  if (hue < 43) return '橙色';
  if (hue < 69) return '黄色';
  if (hue < 175) return '绿色';
  if (hue < 260) return '蓝色';
  return '紫色';
}

async function garmentColorShares(input) {
  try {
    const { data, info } = await sharp(input).autoOrient()
      .resize(sampleSize, sampleSize, { fit: 'fill' }).toColourspace('srgb').ensureAlpha()
      .raw().toBuffer({ resolveWithObject: true });
    const bands = [];
    // Use the middle of the photo, below the face and above the lower edge.
    // The median requires support in multiple bands instead of one accent or patch.
    for (let top = 15; top < 42; top += 9) {
      const counts = new Map();
      let pixels = 0;
      for (let y = top; y < top + 9; y++) {
        for (let x = 18; x < 42; x++) {
          const offset = (y * sampleSize + x) * info.channels;
          if (data[offset + 3] < 224) continue;
          const color = pixelColor(data[offset], data[offset + 1], data[offset + 2]);
          counts.set(color, (counts.get(color) ?? 0) + 1);
          pixels++;
        }
      }
      if (pixels < 170) return null;
      bands.push(new Map([...counts].map(([color, count]) => [color, count / pixels])));
    }
    return bands;
  } catch {
    return null;
  }
}

function share(bands, color) {
  return bands.map(band => band.get(color) ?? 0).sort((a, b) => a - b)[1];
}

export async function groupImageColor({ color, images }) {
  if (!images || images.length < 3) return '';
  const votes = new Map();
  for (const { path } of images) {
    const bands = await garmentColorShares(path);
    if (!bands) continue;
    const colors = color ? [color] : new Set(bands.flatMap(band => [...band.keys()]));
    for (const label of colors) {
      if (share(bands, label) > minimumReferenceShare) {
        votes.set(label, (votes.get(label) ?? 0) + 1);
      }
    }
  }
  return [...votes].find(([, count]) => count > images.length / 2)?.[0] ?? '';
}

export async function productImageColors(images) {
  const results = new Map();
  for (const [id, image] of images) {
    const bands = await garmentColorShares(image);
    if (bands) results.set(id, bands);
  }
  return results;
}

export function matchProductImageColor({ keyword, color }, products, imageColors) {
  if (!color || products.length < 2 ||
      products.some(product => !imageColors.has(product.id))) return undefined;

  const scores = products.map(product => ({
    product,
    score: share(imageColors.get(product.id), color),
  })).sort((a, b) => b.score - a.score);
  const [best, runnerUp] = scores;
  if (best.score < minimumProductShare || runnerUp.score >= minimumProductShare ||
      best.score - runnerUp.score < minimumLead) return undefined;

  const { title, ocrText } = best.product;
  const stated = productColors(keyword, title, ocrText);
  if (stated.length && !stated.includes(color)) return undefined;

  return best.product.id;
}
