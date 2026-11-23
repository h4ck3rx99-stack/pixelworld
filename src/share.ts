import { drawStatic, keyOf, type Cell, type M } from './render.ts';
import { fmt, prettyDay } from './ui.ts';

/** 1080x1920 story card, shared through the Web Share API or downloaded. */
export async function shareCard(cells: Cell[], s: { day: string; dayNo: number; people: number; mine: number }) {
  await Promise.all([document.fonts.load('600 80px "Fraunces Variable"'), document.fonts.load('500 40px "Inter Variable"')]);
  const W = 1080, H = 1920;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const v: M = [470, 0, 0, 470, W / 2, 930];
  drawStatic(g, W, H, v, new Map(cells.map((c) => [keyOf(c), c])), undefined, 0.6);

  g.textAlign = 'center';
  g.fillStyle = '#F7F3E9';
  // Wordmark as in the app: "Rangoli" upright, "Live" italic marigold.
  const up = '600 104px "Fraunces Variable", Georgia, serif', it = 'italic 400 104px "Fraunces Variable", Georgia, serif';
  g.font = up;
  const wa = g.measureText('Rangoli').width;
  g.font = it;
  const wb = g.measureText('Live').width;
  g.textAlign = 'left';
  g.font = up;
  g.fillText('Rangoli', W / 2 - (wa + wb) / 2, 230);
  g.font = it;
  g.fillStyle = '#F5A623';
  g.fillText('Live', W / 2 - (wa + wb) / 2 + wa, 230);
  g.textAlign = 'center';
  g.font = '500 38px "Inter Variable", system-ui, sans-serif';
  g.fillStyle = 'rgba(247,243,233,0.66)';
  g.fillText(`${prettyDay(s.day, true)} · Day ${s.dayNo}`, W / 2, 305);

  g.fillStyle = '#F7F3E9';
  g.font = 'italic 500 66px "Fraunces Variable", Georgia, serif';
  g.fillText(`drawn live by ${fmt(s.people)} ${s.people === 1 ? 'person' : 'people'}`, W / 2, 1560);
  if (s.mine) {
    g.fillStyle = '#F5A623';
    g.font = '600 44px "Inter Variable", system-ui, sans-serif';
    g.fillText(`I added ${fmt(s.mine)} piece${s.mine === 1 ? '' : 's'}`, W / 2, 1645);
  }
  g.fillStyle = 'rgba(247,243,233,0.6)';
  g.font = '500 36px "Inter Variable", system-ui, sans-serif';
  g.fillText(`Add yours → ${location.host}`, W / 2, 1830);

  const blob = await new Promise<Blob>((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error('toBlob'))), 'image/png'));
  const file = new File([blob], `rangoli-${s.day}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], text: `A rangoli drawn live by ${fmt(s.people)} strangers. Add yours: ${location.origin}` });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
