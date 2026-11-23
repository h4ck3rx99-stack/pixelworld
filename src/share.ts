import { PAPER, SIZE } from '../shared/pixels.ts';
import { BG } from './board.ts';
import { fmt } from './ui.ts';

/** 1080x1920 story card of the current canvas, shared through the Web Share API or downloaded. */
export async function shareCard(pixels: HTMLCanvasElement, s: { people: number; pixels: number; mine: number }) {
  await Promise.all([document.fonts.load('800 80px "Inter Variable"'), document.fonts.load('500 40px "Inter Variable"')]);
  const W = 1080, H = 1920, side = 960;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  const x0 = (W - side) / 2, y0 = 470;
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 60;
  g.shadowOffsetY = 18;
  g.fillStyle = PAPER;
  g.fillRect(x0, y0, side, side);
  g.shadowColor = 'transparent';
  g.imageSmoothingEnabled = SIZE > side; // shrinking a big canvas reads better smoothed; enlarging stays crisp
  g.drawImage(pixels, x0, y0, side, side);

  g.textAlign = 'center';
  wordmark(g, W / 2, 250, 112);
  g.font = '500 40px "Inter Variable", system-ui, sans-serif';
  g.fillStyle = 'rgba(244,241,234,0.66)';
  g.fillText('One canvas. The whole world.', W / 2, 330);

  g.fillStyle = '#F4F1EA';
  g.font = '700 58px "Inter Variable", system-ui, sans-serif';
  g.fillText(`${fmt(s.pixels)} pixels by ${fmt(s.people)} ${s.people === 1 ? 'person' : 'people'}`, W / 2, 1570);
  if (s.mine) {
    g.fillStyle = '#FFD93B';
    g.font = '700 46px "Inter Variable", system-ui, sans-serif';
    g.fillText(`I placed ${fmt(s.mine)} of them`, W / 2, 1650);
  }
  g.fillStyle = 'rgba(244,241,234,0.6)';
  g.font = '500 38px "Inter Variable", system-ui, sans-serif';
  g.fillText(`Add yours → ${location.host}`, W / 2, 1830);

  const blob = await new Promise<Blob>((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error('toBlob'))), 'image/png'));
  const file = new File([blob], 'pixelworld.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], text: `One canvas, ${fmt(s.people)} people. Add your pixel: ${location.origin}` });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** "Pixel" in paper white + "World" in yellow, centred on x. */
function wordmark(g: CanvasRenderingContext2D, x: number, y: number, px: number) {
  g.font = `800 ${px}px "Inter Variable", system-ui, sans-serif`;
  const a = g.measureText('Pixel').width, b = g.measureText('World').width;
  g.textAlign = 'left';
  g.fillStyle = '#F4F1EA';
  g.fillText('Pixel', x - (a + b) / 2, y);
  g.fillStyle = '#FFD93B';
  g.fillText('World', x - (a + b) / 2 + a, y);
  g.textAlign = 'center';
}
