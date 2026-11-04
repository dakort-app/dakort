// Pasted and attached images. Claude (Opus 4.7 and later) takes images up
// to 2576 px on the long edge and 3.75 megapixels and scales anything
// larger down itself, so a 12 MB phone photo or a full 4K screenshot is
// shrunk to that here before it is base64'd into the request. (It was 1568
// px, the older models' limit: a 3840x2400 screenshot went to 40% and its
// small text with it.)

export type Attachment = { mediaType: string; data: string; url: string; size: number }

const maxEdge = 2576
const maxPixels = 3_750_000
// The API takes at most 5 MB per image, counted in base64 (4/3 of the bytes).
const maxBytes = 3_700_000
const keepTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

// scaleFor is how much an image of w x h must shrink (1: not at all).
export const scaleFor = (w: number, h: number) => Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)))

export async function attach(file: Blob, url = ''): Promise<Attachment> {
  let blob = file
  let type = file.type
  const bmp = await createImageBitmap(file)
  const scale = scaleFor(bmp.width, bmp.height)
  // Small images in a type the API takes go as they are; GIFs too, since
  // a canvas would keep only the first frame.
  const small = scale === 1 && file.size < 1_500_000 && keepTypes.has(type)
  if (!small && type !== 'image/gif') {
    const c = document.createElement('canvas')
    c.width = Math.round(bmp.width * scale)
    c.height = Math.round(bmp.height * scale)
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
    const encode = (t: string) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('image encode failed'))), t, 0.85))
    // A screenshot stays PNG: JPEG blurs the edges of letters. Photos, and
    // a PNG too big for the API, go as JPEG.
    type = type === 'image/png' ? 'image/png' : 'image/jpeg'
    blob = await encode(type)
    if (blob.size > maxBytes && type === 'image/png') blob = await encode((type = 'image/jpeg'))
  }
  bmp.close()
  return { mediaType: type, data: await base64(blob), url: url || URL.createObjectURL(blob), size: blob.size }
}

// attachNow shows an image at once, from the file as pasted, while attach
// shrinks and encodes it (a few hundred ms for a 4K screenshot): the item
// has no data until done. ready waits for a list's items to be done. A
// finished job stays: a composer left mid-job (another tab) keeps the item
// without data in its draft, and finds the result here on the way back.
const jobs = new Map<string, Promise<Attachment>>()

export function attachNow(file: Blob): { item: Attachment; done: Promise<Attachment> } {
  const item = { mediaType: '', data: '', url: URL.createObjectURL(file), size: file.size }
  const done = attach(file, item.url)
  jobs.set(item.url, done)
  done.catch(() => jobs.delete(item.url))
  return { item, done }
}

export const ready = (list: Attachment[]) => Promise.all(list.map((a) => (a.data ? a : (jobs.get(a.url) ?? Promise.reject(new Error('image lost'))))))

function base64(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })
}
