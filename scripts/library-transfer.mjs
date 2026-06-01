// Library export/import — move your taste data between databases (e.g. dump
// production, load it into your local dev DB).
//
// "Library" here = your ratings + labels + track-labels, plus the catalog rows
// they reference (tracks, artists, track_artists) so the dev UI shows real
// titles/art/artist grouping. It does NOT touch plays, shuffle sessions/presets,
// AI suggestions, top lists, users, or Spotify tokens.
//
// The DB is chosen from (in order): --db <url>, then DATABASE_URL. In dev,
// DATABASE_URL is loaded from .env automatically; for prod pass it explicitly:
//
//   # Export your prod library to a file
//   DATABASE_URL='postgres://…prod…' pnpm library:export --out lib.json
//
//   # Load it into your local dev DB (uses .env's DATABASE_URL)
//   pnpm library:import lib.json
//
// User selection: if the DB has exactly one user, that user is used. Otherwise
// pass --user <spotifyId> to disambiguate. On import the target user must
// already exist (log into dev once first) — this script never creates users.
//
// Import is idempotent and runs in a single transaction: catalog rows are
// upserted, labels matched by name, ratings/labels re-pointed at the target
// user. Re-running with the same file converges to the same state. Use
// --dry-run to preview counts and roll back.

import 'dotenv/config';
import postgres from 'postgres';
import { readFileSync, writeFileSync } from 'node:fs';

const FORMAT_VERSION = 1;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--user') args.user = argv[++i];
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else args._.push(a);
  }
  return args;
}

function die(msg) {
  console.error(`library-transfer: ${msg}`);
  process.exit(1);
}

async function resolveUser(sql, spotifyId, { mustExist } = {}) {
  if (spotifyId) {
    const rows = await sql`
      select id, spotify_id, display_name from users where spotify_id = ${spotifyId} limit 1`;
    if (!rows[0]) die(`no user with spotify_id "${spotifyId}" in this database`);
    return rows[0];
  }
  const all = await sql`select id, spotify_id, display_name from users order by created_at`;
  if (all.length === 1) return all[0];
  if (all.length === 0) {
    die(
      mustExist
        ? 'target database has no users — log into the app once to create your user, then re-run'
        : 'database has no users to export',
    );
  }
  const list = all.map((u) => `  - ${u.spotify_id}${u.display_name ? ` (${u.display_name})` : ''}`);
  die(`multiple users found — pass --user <spotifyId> to pick one:\n${list.join('\n')}`);
}

async function doExport(sql, args) {
  const user = await resolveUser(sql, args.user);
  console.error(`exporting library for ${user.spotify_id}${user.display_name ? ` (${user.display_name})` : ''}`);

  const ratings = await sql`
    select spotify_track_uri, isrc, rating_stars, rated_at
    from ratings where user_id = ${user.id}`;
  const labels = await sql`
    select id, name, last_used_at, created_at
    from labels where user_id = ${user.id}`;
  const trackLabels = await sql`
    select spotify_track_uri, label_id, applied_at
    from track_labels where user_id = ${user.id}`;

  // Catalog rows referenced by the taste data (so dev shows real metadata).
  const uris = [
    ...new Set([
      ...ratings.map((r) => r.spotify_track_uri),
      ...trackLabels.map((t) => t.spotify_track_uri),
    ]),
  ];

  let tracks = [];
  let trackArtists = [];
  let artists = [];
  if (uris.length > 0) {
    tracks = await sql`
      select spotify_track_uri, isrc, title, artists, album, album_art_url, duration_ms,
             fetched_at, release_date, explicit, genres, primary_artist_id, canonical_title,
             version_type, song_family_id, duplicate_group_id
      from tracks where spotify_track_uri in ${sql(uris)}`;
    trackArtists = await sql`
      select spotify_track_uri, spotify_artist_id, position
      from track_artists where spotify_track_uri in ${sql(uris)}`;
    const artistIds = [...new Set(trackArtists.map((t) => t.spotify_artist_id))];
    if (artistIds.length > 0) {
      artists = await sql`
        select spotify_artist_id, name, genres, fetched_at
        from artists where spotify_artist_id in ${sql(artistIds)}`;
    }
  }

  const payload = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    user: { spotifyId: user.spotify_id, displayName: user.display_name },
    counts: {
      ratings: ratings.length,
      labels: labels.length,
      trackLabels: trackLabels.length,
      tracks: tracks.length,
      artists: artists.length,
      trackArtists: trackArtists.length,
    },
    tracks,
    artists,
    trackArtists,
    ratings,
    labels,
    trackLabels,
  };

  const out = args.out || args._[0];
  const text = JSON.stringify(payload, null, 2);
  if (out) {
    writeFileSync(out, text);
    console.error(`wrote ${out}`);
  } else {
    process.stdout.write(text + '\n');
  }
  console.error(`counts: ${JSON.stringify(payload.counts)}`);
}

async function doImport(sql, args) {
  const file = args._[0];
  if (!file) die('import: pass the export file path, e.g. `pnpm library:import lib.json`');

  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    die(`could not read/parse ${file}: ${err.message}`);
  }
  if (payload.formatVersion !== FORMAT_VERSION) {
    die(`unsupported formatVersion ${payload.formatVersion} (this tool writes v${FORMAT_VERSION})`);
  }

  const user = await resolveUser(sql, args.user, { mustExist: true });
  console.error(
    `importing into ${user.spotify_id}${user.display_name ? ` (${user.display_name})` : ''}` +
      (payload.user?.spotifyId ? ` (from export of ${payload.user.spotifyId})` : ''),
  );

  const applied = { tracks: 0, artists: 0, trackArtists: 0, labels: 0, trackLabels: 0, ratings: 0 };

  await sql.begin(async (tx) => {
    // 1. Catalog — upsert so dev metadata matches the export. Artists before
    //    track_artists (FK), tracks have no inbound FK so order is free.
    if (payload.artists?.length) {
      await tx`
        insert into artists ${tx(payload.artists, 'spotify_artist_id', 'name', 'genres', 'fetched_at')}
        on conflict (spotify_artist_id) do update set
          name = excluded.name, genres = excluded.genres, fetched_at = excluded.fetched_at`;
      applied.artists = payload.artists.length;
    }
    if (payload.tracks?.length) {
      await tx`
        insert into tracks ${tx(
          payload.tracks,
          'spotify_track_uri', 'isrc', 'title', 'artists', 'album', 'album_art_url', 'duration_ms',
          'fetched_at', 'release_date', 'explicit', 'genres', 'primary_artist_id', 'canonical_title',
          'version_type', 'song_family_id', 'duplicate_group_id',
        )}
        on conflict (spotify_track_uri) do update set
          isrc = excluded.isrc, title = excluded.title, artists = excluded.artists,
          album = excluded.album, album_art_url = excluded.album_art_url,
          duration_ms = excluded.duration_ms, fetched_at = excluded.fetched_at,
          release_date = excluded.release_date, explicit = excluded.explicit,
          genres = excluded.genres, primary_artist_id = excluded.primary_artist_id,
          canonical_title = excluded.canonical_title, version_type = excluded.version_type,
          song_family_id = excluded.song_family_id, duplicate_group_id = excluded.duplicate_group_id`;
      applied.tracks = payload.tracks.length;
    }
    if (payload.trackArtists?.length) {
      // Reconcile joins so the catalog matches the payload: drop existing rows
      // for the tracks the export carries artist data for, then re-insert. Scoped
      // to those track URIs (not all imported tracks) so an export that simply
      // hadn't enriched a track doesn't wipe this DB's existing joins for it.
      const taUris = [...new Set(payload.trackArtists.map((t) => t.spotify_track_uri))];
      await tx`delete from track_artists where spotify_track_uri in ${tx(taUris)}`;
      await tx`
        insert into track_artists ${tx(payload.trackArtists, 'spotify_track_uri', 'spotify_artist_id', 'position')}
        on conflict (spotify_track_uri, spotify_artist_id) do update set position = excluded.position`;
      applied.trackArtists = payload.trackArtists.length;
    }

    // 2. Labels — matched by (user, name). Build oldId -> newId so track_labels
    //    can re-point at this DB's label rows.
    const labelIdMap = new Map();
    for (const label of payload.labels ?? []) {
      const rows = await tx`
        insert into labels ${tx(
          [{ user_id: user.id, name: label.name, last_used_at: label.last_used_at, created_at: label.created_at }],
          'user_id', 'name', 'last_used_at', 'created_at',
        )}
        on conflict (user_id, name) do update set last_used_at = excluded.last_used_at
        returning id`;
      labelIdMap.set(label.id, rows[0].id);
      applied.labels++;
    }

    // 3. Track-labels — re-pointed at target user + mapped label ids.
    const tlRows = (payload.trackLabels ?? [])
      .filter((t) => labelIdMap.has(t.label_id))
      .map((t) => ({
        user_id: user.id,
        spotify_track_uri: t.spotify_track_uri,
        label_id: labelIdMap.get(t.label_id),
        applied_at: t.applied_at,
      }));
    if (tlRows.length) {
      await tx`
        insert into track_labels ${tx(tlRows, 'user_id', 'spotify_track_uri', 'label_id', 'applied_at')}
        on conflict (user_id, spotify_track_uri, label_id) do update set applied_at = excluded.applied_at`;
      applied.trackLabels = tlRows.length;
    }

    // 4. Ratings — re-pointed at target user; stars/timestamp win on conflict.
    const ratingRows = (payload.ratings ?? []).map((r) => ({
      user_id: user.id,
      spotify_track_uri: r.spotify_track_uri,
      isrc: r.isrc,
      rating_stars: r.rating_stars,
      rated_at: r.rated_at,
    }));
    if (ratingRows.length) {
      await tx`
        insert into ratings ${tx(ratingRows, 'user_id', 'spotify_track_uri', 'isrc', 'rating_stars', 'rated_at')}
        on conflict (user_id, spotify_track_uri) do update set
          isrc = excluded.isrc, rating_stars = excluded.rating_stars, rated_at = excluded.rated_at`;
      applied.ratings = ratingRows.length;
    }

    if (args.dryRun) {
      console.error('dry-run: rolling back');
      throw new RollbackSignal();
    }
  }).catch((err) => {
    if (err instanceof RollbackSignal) return;
    throw err;
  });

  console.error(`${args.dryRun ? 'would apply' : 'applied'}: ${JSON.stringify(applied)}`);
}

class RollbackSignal extends Error {}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== 'export' && cmd !== 'import') {
    die('usage: library-transfer.mjs <export|import> [file] [--user <spotifyId>] [--out <file>] [--db <url>] [--dry-run]');
  }
  const args = parseArgs(argv.slice(1));

  const url = args.db || process.env.DATABASE_URL;
  if (!url) die('no database URL — set DATABASE_URL or pass --db <url>');

  const sql = postgres(url, { max: 1 });
  try {
    if (cmd === 'export') await doExport(sql, args);
    else await doImport(sql, args);
  } catch (err) {
    console.error('library-transfer: failed');
    console.error(err);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
