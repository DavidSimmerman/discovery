import { stars } from './stars';

export interface TrackForMeta {
  uri: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images: { url: string; width?: number; height?: number }[] };
}

export interface MediaActions {
  togglePlay(): void | Promise<void>;
  next(): void | Promise<void>;
  prev(): void | Promise<void>;
  seek(positionMs: number): void | Promise<void>;
}

function ms(): MediaSession | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator).mediaSession ?? null;
}

export function setMediaMetadata(track: TrackForMeta, ratingStars: number | null): void {
  const s = ms();
  if (!s) return;
  const prefix = stars(ratingStars);
  const title = prefix ? `${prefix} ${track.name}` : track.name;
  s.metadata = new MediaMetadata({
    title,
    artist: track.artists.map((a) => a.name).join(', '),
    album: track.album.name,
    artwork: track.album.images.map((i) => ({
      src: i.url,
      sizes: i.width && i.height ? `${i.width}x${i.height}` : undefined,
    })) as MediaImage[],
  });
}

export function setMediaActionHandlers(store: MediaActions): void {
  const s = ms();
  if (!s) return;
  const safe = (name: MediaSessionAction, fn: (details: MediaSessionActionDetails) => void) => {
    try {
      s.setActionHandler(name, fn);
    } catch {
      // Some platforms throw NotSupportedError for unsupported actions; ignore.
    }
  };
  safe('play', () => void store.togglePlay());
  safe('pause', () => void store.togglePlay());
  safe('previoustrack', () => void store.prev());
  safe('nexttrack', () => void store.next());
  safe('seekto', (d) => {
    if (typeof d.seekTime === 'number') store.seek(Math.round(d.seekTime * 1000));
  });
}
