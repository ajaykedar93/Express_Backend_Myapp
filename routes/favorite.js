// routes/favorites.js
const express = require('express');
const db = require('../db'); // pg Pool/Client wrapper
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const router = express.Router();

/* ----------------------- CONFIG ----------------------- */
const FAVORITE_CATEGORIES = [
  'Korean Top Favorite Series','Hollywood Top Series','Bollywood Top Series',
  'Anime Top Series','Comedy Series','Drama Series','Action Series',
  'Thriller Series','Sci-Fi Series','Fantasy Series','Mystery Series',
  'Romantic Series','Documentary Series','Superhero Series','Crime Series',
  'Top Movies','Action Movies','Romantic Movies','Horror Movies','Comedy Movies',
  'Sci-Fi Movies','Thriller Movies','Drama Movies','Animated Movies','Fantasy Movies',
  'Superhero Movies','Adventure Movies','Documentary Movies','Crime Movies','Classic Movies',
  'Blockbuster Movies','Award-Winning Movies','Family Movies'
];
/* ----------------------- FAVORITES: Share PDF (Ajay Kedar themed, full details) ----------------------- */
/* ----------------------- FAVORITES: Share PDF (bright, professional, no overlap) ----------------------- */
// POST /api/favorites/share-bucket-pdf
router.post('/share-bucket-pdf', async (req, res) => {
  const { user_id, favorite_category, to_email } = req.body || {};
  let filePath;

  /* ---------- Bright visual theme ---------- */
  const palette = {
    bg: '#ffffff',
    card: '#f8fafc',
    text: '#0f172a',
    muted: '#64748b',
    accent: '#2563eb',
    accent2: '#7c3aed',
    divider: '#e5e7eb',
    movie: '#10b981',
    series: '#2563eb',
    chip: '#eef2ff',
  };
  const mm = (n) => (n * 72) / 25.4;
  const fmtStamp = () => {
    try { return new Date().toLocaleString(); } catch { return new Date().toISOString(); }
  };

  /* ---------- PDF helpers (spacing-safe) ---------- */
  const drawPageHeader = (doc, title, subtitle) => {
    doc.save();
    // header band
    doc.rect(0, 0, doc.page.width, mm(26)).fill(palette.card);
    // title
    doc.fill(palette.text).font('Helvetica-Bold').fontSize(18);
    doc.text(title, mm(20), mm(8), { align: 'left' });
    // subtitle
    doc.fill(palette.muted).font('Helvetica').fontSize(9);
    doc.text(subtitle, mm(20), mm(16), { align: 'left' });
    // bottom border
    doc.rect(0, mm(26), doc.page.width, 1).fill(palette.divider);
    doc.restore();
    // start content a bit lower
    doc.y = mm(34);
  };

  const drawPageFooter = (doc) => {
    const footerY = doc.page.height - mm(12);
    doc.save();
    doc.fill(palette.muted).font('Helvetica').fontSize(8);
    const text = `Page ${doc.page.number}`;
    const w = doc.widthOfString(text);
    doc.text(text, doc.page.width - mm(20) - w, footerY);
    doc.restore();
  };

  const ensurePageSpace = (doc, neededHeight = mm(28)) => {
    if (doc.y + neededHeight > doc.page.height - mm(16)) {
      doc.addPage({ margin: mm(14) });
      // faint header strip for new page
      doc.save();
      doc.rect(0, 0, doc.page.width, mm(10)).fill(palette.card);
      doc.restore();
      // top padding
      doc.y = mm(18);
    }
  };

  const chip = (doc, x, y, text, color) => {
    const padX = 6, padY = 3;
    doc.save();
    doc.font('Helvetica-Bold').fontSize(9);
    const w = doc.widthOfString(String(text)) + padX * 2;
    const h = doc.currentLineHeight() + padY * 2 - 2;
    doc.roundedRect(x, y, w, h, 6).fill(palette.chip);
    doc.fill(color).text(String(text), x + padX, y + padY - 1);
    doc.restore();
    return { w, h };
  };

  // render chips in rows; returns { nextY, lastHeight }
  const chipsRow = (doc, startX, startY, items, color) => {
    if (!items || !items.length) return { nextY: startY, lastHeight: 0 };
    let x = startX;
    let y = startY;
    let rowH = 0;
    items.forEach((t, i) => {
      const { w, h } = chip(doc, x, y, t, color);
      rowH = Math.max(rowH, h);
      x += w + 6;
      const rightLimit = doc.page.width - mm(20);
      if (x > rightLimit) {
        // wrap to next line
        x = startX;
        y += rowH + 4;
        rowH = 0;
      }
    });
    return { nextY: y + (rowH || 0), lastHeight: rowH };
  };

  const sectionHeading = (doc, title, count, color) => {
    ensurePageSpace(doc, mm(20));
    const x = mm(20);
    doc.save();
    doc.fill(color).font('Helvetica-Bold').fontSize(13).text(title, x, doc.y, { continued: true });
    doc.fill(palette.muted).font('Helvetica').fontSize(11).text(`   •   ${count} item${count === 1 ? '' : 's'}`);
    const y = doc.y + 4;
    doc.rect(mm(20), y, doc.page.width - mm(40), 1).fill(palette.divider);
    doc.restore();
    doc.y = y + 10; // space after heading
  };

  // single row renderer with explicit y management (prevents overlap)
  const row = (doc, idx, title, rightText, catName, subcatName, genresArr, partsOrSeasonsArr, isMovie) => {
    ensurePageSpace(doc, mm(24));
    const startX = mm(24);
    const rightX = doc.page.width - mm(22);

    // Title and right meta on the same baseline
    doc.save();
    doc.font('Helvetica-Bold').fontSize(11).fill(palette.text);
    const titleY = doc.y;
    const maxW = rightX - startX - 120;
    doc.text(`${idx}. ${title}`, startX, titleY, { width: maxW });
    // compute baseline after title
    const afterTitleY = doc.y;
    // Right meta (year • watched) aligned to titleY baseline
    doc.font('Helvetica').fontSize(10).fill(palette.accent2);
    const rtW = doc.widthOfString(rightText || '');
    doc.text(rightText || '', rightX - rtW, titleY);
    // continue below whichever is lower
    let y = Math.max(afterTitleY, titleY + doc.currentLineHeight());

    // Category / Subcategory chips
    const catChips = [catName || '—'].concat(subcatName ? [subcatName] : []);
    y += 4;
    let rowRes = chipsRow(doc, startX, y, catChips, palette.accent);
    y = rowRes.nextY;

    // Genres chips
    if (genresArr && genresArr.length) {
      y += 6;
      rowRes = chipsRow(doc, startX, y, genresArr, palette.accent2);
      y = rowRes.nextY;
    }

    // Parts / Seasons line (plain text to keep baseline tidy)
    if (partsOrSeasonsArr && partsOrSeasonsArr.length) {
      y += 8;
      ensurePageSpace(doc, mm(10));
      doc.font('Helvetica').fontSize(9).fill(palette.muted);
      const label = isMovie ? 'Parts:' : 'Seasons:';
      doc.text(`${label} ${partsOrSeasonsArr.join(', ')}`, startX, y);
      y = doc.y;
    }

    // Divider and pad
    const divY = y + 8;
    doc.rect(mm(20), divY, doc.page.width - mm(40), 0.8).fill(palette.divider);
    doc.restore();
    doc.y = divY + 8; // next row starts after divider
  };

  try {
    /* ---------- Validate ---------- */
    if (!user_id || !favorite_category || !to_email) {
      return res.status(400).json({ error: 'user_id, favorite_category and to_email are required.' });
    }
    if (!FAVORITE_CATEGORIES.includes(favorite_category)) {
      return res.status(400).json({ error: 'favorite_category not allowed.' });
    }

    /* ---------- Fetch all rows with genres + parts/seasons ---------- */
    const moviesSql = `
      SELECT
        f.favorite_id,
        f.name AS title,
        f.year AS release_year,
        f.poster_url,
        f.is_watched,
        f.category_id, c.name AS category_name,
        f.subcategory_id, sc.name AS subcategory_name,
        f.movie_id,
        (
          SELECT array_agg(CONCAT('Part ', mp.part_number, ' (', mp.year, ')') ORDER BY mp.part_number)
          FROM movie_parts mp
          WHERE mp.movie_id = f.movie_id
        ) AS parts,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM movie_genres mg
          JOIN genres g ON g.genre_id = mg.genre_id
          WHERE mg.movie_id = f.movie_id
        ) AS genres
      FROM favorites f
      JOIN categories c          ON c.category_id = f.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = f.subcategory_id
      WHERE f.user_id = $1 AND f.favorite_category = $2 AND f.movie_id IS NOT NULL
      ORDER BY COALESCE(f.position, 999999), f.favorite_id DESC;
    `;

    const seriesSql = `
      SELECT
        f.favorite_id,
        f.name AS title,
        f.year AS release_year,
        f.poster_url,
        f.is_watched,
        f.category_id, c.name AS category_name,
        f.subcategory_id, sc.name AS subcategory_name,
        f.series_id,
        (
          SELECT array_agg(CONCAT('Season ', se.season_no, ' (', se.year, ')') ORDER BY se.season_no)
          FROM seasons se
          WHERE se.series_id = f.series_id
        ) AS seasons,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM series_genres sg
          JOIN genres g ON g.genre_id = sg.genre_id
          WHERE sg.series_id = f.series_id
        ) AS genres
      FROM favorites f
      JOIN categories c          ON c.category_id = f.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = f.subcategory_id
      WHERE f.user_id = $1 AND f.favorite_category = $2 AND f.series_id IS NOT NULL
      ORDER BY COALESCE(f.position, 999999), f.favorite_id DESC;
    `;

    const [mRes, sRes] = await Promise.all([
      db.query(moviesSql, [user_id, favorite_category]),
      db.query(seriesSql, [user_id, favorite_category]),
    ]);

    const movies = mRes.rows || [];
    const series = sRes.rows || [];
    const counts = { movies: movies.length, series: series.length, total: movies.length + series.length };

    /* ---------- Build PDF ---------- */
    const tmpDir = path.join(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `favorites_${user_id}_${Date.now()}.pdf`;
    filePath = path.join(tmpDir, filename);

    const doc = new PDFDocument({ size: 'A4', margin: mm(14) });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // background
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(palette.bg);

    // static title per your request
    drawPageHeader(
      doc,
      'Ajay Kedar – Movies or Series List',
      `Bucket: ${favorite_category} • User #${user_id} • ${fmtStamp()}`
    );

    // quick summary chips
    doc.font('Helvetica').fontSize(10).fill(palette.muted);
    const summaryY = doc.y;
    const { nextY } = chipsRow(
      doc,
      mm(20),
      summaryY,
      [`${counts.total} total`, `${counts.movies} movies`, `${counts.series} series`],
      palette.accent
    );
    doc.y = nextY + 8;

    // MOVIES
    sectionHeading(doc, 'Movies', counts.movies, palette.movie);
    if (!movies.length) {
      doc.fill(palette.muted).font('Helvetica').fontSize(10)
        .text('No movies in this bucket yet.', mm(24));
      doc.y += 8;
    } else {
      movies.forEach((m, i) => {
        const metaRight = `${m.release_year || ''}${m.is_watched ? '  •  Watched' : ''}`;
        row(
          doc,
          i + 1,
          m.title,
          metaRight,
          m.category_name,
          m.subcategory_name,
          m.genres || [],
          m.parts || [],
          true
        );
      });
    }

    // SERIES
    sectionHeading(doc, 'Series', counts.series, palette.series);
    if (!series.length) {
      doc.fill(palette.muted).font('Helvetica').fontSize(10)
        .text('No series in this bucket yet.', mm(24));
      doc.y += 8;
    } else {
      series.forEach((s, i) => {
        const metaRight = `${s.release_year || ''}${s.is_watched ? '  •  Watched' : ''}`;
        row(
          doc,
          i + 1,
          s.title,
          metaRight,
          s.category_name,
          s.subcategory_name,
          s.genres || [],
          s.seasons || [],
          false
        );
      });
    }

    // footer
    doc.moveDown(1);
    doc.fill(palette.muted).font('Helvetica').fontSize(8)
      .text('Favorites • Generated by your app', mm(20));
    drawPageFooter(doc);

    // finalize
    doc.end();
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    /* ---------- Send email ---------- */
    const transporter = process.env.SMTP_HOST
      ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 465),
          secure: String(process.env.SMTP_SECURE || 'true') === 'true',
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        })
      : nodemailer.createTransport({
          service: 'gmail',
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
        });

    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: to_email,
      subject: `Favorites — ${favorite_category}`,
      text: `Attached is the ${favorite_category} favorites list for user #${user_id}. Total items: ${counts.total}.`,
      attachments: [{ filename: `Favorites - ${favorite_category}.pdf`, path: filePath }],
    });

    // cleanup
    fs.unlink(filePath, () => {});
    return res.json({
      ok: true,
      sent_to: to_email,
      favorite_category,
      counts,
      mail_response: info.response || 'sent',
    });
  } catch (err) {
    console.error('share-bucket-pdf error:', err);
    if (filePath) { try { fs.unlinkSync(filePath); } catch (_) {} }
    return res.status(500).json({ error: 'Failed to generate or send PDF' });
  }
});



// GET /api/favorites/bucket?user_id=&favorite_category=
router.get('/bucket', async (req, res) => {
  try {
    const user_id = Number(req.query.user_id);
    const favorite_category = String(req.query.favorite_category || '');

    if (!user_id || !favorite_category) {
      return res.status(400).json({ error: 'user_id and favorite_category are required.' });
    }

    const moviesSql = `
      SELECT f.favorite_id, f.name AS title, f.year AS release_year, f.poster_url, f.is_watched,
             f.position, f.created_at, f.updated_at, f.category_id, c.name AS category_name,
             f.subcategory_id, sc.name AS subcategory_name, f.movie_id AS id
      FROM favorites f
      JOIN categories c ON c.category_id = f.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = f.subcategory_id
      WHERE f.user_id = $1 AND f.favorite_category = $2 AND f.movie_id IS NOT NULL
      ORDER BY COALESCE(f.position, 999999), f.favorite_id DESC;
    `;
    const seriesSql = `
      SELECT f.favorite_id, f.name AS title, f.year AS release_year, f.poster_url, f.is_watched,
             f.position, f.created_at, f.updated_at, f.category_id, c.name AS category_name,
             f.subcategory_id, sc.name AS subcategory_name, f.series_id AS id
      FROM favorites f
      JOIN categories c ON c.category_id = f.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = f.subcategory_id
      WHERE f.user_id = $1 AND f.favorite_category = $2 AND f.series_id IS NOT NULL
      ORDER BY COALESCE(f.position, 999999), f.favorite_id DESC;
    `;
    const countsSql = `
      WITH fm AS (
        SELECT COUNT(*)::int AS movies_cnt FROM favorites WHERE user_id=$1 AND favorite_category=$2 AND movie_id IS NOT NULL
      ),
      fs AS (
        SELECT COUNT(*)::int AS series_cnt FROM favorites WHERE user_id=$1 AND favorite_category=$2 AND series_id IS NOT NULL
      )
      SELECT fm.movies_cnt, fs.series_cnt, (fm.movies_cnt + fs.series_cnt) AS total_cnt FROM fm, fs;
    `;

    const [mRes, sRes, cRes] = await Promise.all([
      db.query(moviesSql, [user_id, favorite_category]),
      db.query(seriesSql, [user_id, favorite_category]),
      db.query(countsSql,  [user_id, favorite_category]),
    ]);

    const c = cRes.rows[0] || { movies_cnt: 0, series_cnt: 0, total_cnt: 0 };
    return res.json({
      favorite_category,
      counts: { movies: c.movies_cnt, series: c.series_cnt, total: c.total_cnt },
      movies: mRes.rows,
      series: sRes.rows
    });
  } catch (err) {
    console.error('bucket fetch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


/* ----------------------- FAVORITES: Remove ONE ----------------------- */
// POST /api/favorites/favorites/remove
router.post('/favorites/remove', async (req, res) => {
  const { user_id, favorite_id } = req.body || {};

  try {
    // Basic validation
    if (!user_id || !favorite_id) {
      return res.status(400).json({ error: 'user_id and favorite_id are required.' });
    }

    // 1) Find the row to ensure it exists and belongs to the user
    const findSql = `
      SELECT favorite_id, user_id, favorite_category
      FROM favorites
      WHERE favorite_id = $1
      LIMIT 1;
    `;
    const findRes = await db.query(findSql, [favorite_id]);
    if (findRes.rowCount === 0) {
      return res.status(404).json({ error: 'Favorite not found.' });
    }
    const row = findRes.rows[0];
    if (Number(row.user_id) !== Number(user_id)) {
      return res.status(403).json({ error: 'Not allowed to delete this favorite.' });
    }

    // 2) Delete the favorite
    const delSql = `DELETE FROM favorites WHERE favorite_id = $1 AND user_id = $2;`;
    await db.query(delSql, [favorite_id, user_id]);

    // 3) Return updated counts for the same bucket (optional but handy)
    const countsSql = `
      WITH fm AS (
        SELECT COUNT(*)::int AS movies_cnt
        FROM favorites
        WHERE user_id = $1
          AND favorite_category = $2
          AND movie_id IS NOT NULL
      ),
      fs AS (
        SELECT COUNT(*)::int AS series_cnt
        FROM favorites
        WHERE user_id = $1
          AND favorite_category = $2
          AND series_id IS NOT NULL
      )
      SELECT fm.movies_cnt, fs.series_cnt, (fm.movies_cnt + fs.series_cnt) AS total_cnt
      FROM fm, fs;
    `;
    const countsRes = await db.query(countsSql, [user_id, row.favorite_category]);
    const c = countsRes.rows[0] || { movies_cnt: 0, series_cnt: 0, total_cnt: 0 };

    return res.json({
      ok: true,
      removed_favorite_id: Number(favorite_id),
      favorite_category: row.favorite_category,
      counts: { movies: c.movies_cnt, series: c.series_cnt, total: c.total_cnt },
    });
  } catch (err) {
    console.error('favorites/remove error:', err);
    return res.status(500).json({ error: 'Failed to remove favorite' });
  }
});


/* ----------------------- FAVORITES: Add & Fetch Bucket ----------------------- */
// POST /api/favorites/add-and-fetch-category
router.post('/add-and-fetch-category', async (req, res) => {
  const client = await db.connect();
  try {
    const {
      user_id,
      item_type,
      item_id,
      category_id,
      subcategory_id = null,
      year,
      name,
      poster_url = null,
      is_watched = false,
      favorite_category
    } = req.body || {};

    // ---------- validation ----------
    if (!user_id || !item_type || !item_id || !category_id || !year || !name || !favorite_category) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    if (!['movie', 'series'].includes(String(item_type))) {
      return res.status(400).json({ error: 'item_type must be "movie" or "series".' });
    }
    if (!FAVORITE_CATEGORIES.includes(favorite_category)) {
      return res.status(400).json({ error: 'favorite_category not allowed.' });
    }

    const isMovie = item_type === 'movie';
    const movie_id = isMovie ? item_id : null;
    const series_id = isMovie ? null : item_id;

    // ---------- transaction with SAVEPOINT ----------
    await client.query('BEGIN');
    await client.query('SAVEPOINT addfav');

    const insertSql = `
      INSERT INTO favorites
        (user_id, movie_id, series_id, name, category_id, subcategory_id,
         genre_ids, part_or_season, year, poster_url, is_watched,
         favorite_category, position, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,
              NULL,NULL,$7,$8,$9,
              $10,NULL, NOW(), NOW());
    `;
    const insertParams = [
      user_id, movie_id, series_id, name, category_id, subcategory_id,
      year, poster_url, is_watched, favorite_category
    ];

    try {
      await client.query(insertSql, insertParams);
    } catch (e) {
      if (e && e.code === '23505') {
        // unique violation -> item already favorited by this user/category (+ movie or series)
        // recover txn and move it to the new bucket
        await client.query('ROLLBACK TO SAVEPOINT addfav');

        const updateSql = `
          UPDATE favorites
          SET favorite_category = $1,
              name = COALESCE($2, name),
              year = COALESCE($3, year),
              poster_url = COALESCE($4, poster_url),
              is_watched = COALESCE($5, is_watched),
              subcategory_id = COALESCE($6, subcategory_id),
              updated_at = NOW()
          WHERE user_id = $7
            AND category_id = $8
            AND (
              ($9::bigint IS NOT NULL AND movie_id = $9 AND series_id IS NULL) OR
              ($10::bigint IS NOT NULL AND series_id = $10 AND movie_id IS NULL)
            );
        `;
        await client.query(updateSql, [
          favorite_category,
          name,
          year,
          poster_url,
          is_watched,
          subcategory_id,
          user_id,
          category_id,
          movie_id,
          series_id
        ]);
      } else {
        // some other error -> abort whole transaction
        throw e;
      }
    }

    // ---------- fetch the updated bucket ----------
    const moviesSql = `
      SELECT
        f.favorite_id,
        f.name AS title,
        f.year AS release_year,
        f.poster_url,
        f.is_watched,
        f.position,
        f.created_at,
        f.updated_at,
        f.category_id,
        c.name AS category_name,
        f.subcategory_id,
        sc.name AS subcategory_name,
        f.movie_id AS id
      FROM favorites f
      JOIN categories c          ON c.category_id = f.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = f.subcategory_id
      WHERE f.user_id = $1
        AND f.favorite_category = $2
        AND f.movie_id IS NOT NULL
      ORDER BY COALESCE(f.position, 999999), f.favorite_id DESC;
    `;

    const seriesSql = `
      SELECT
        f.favorite_id,
        f.name AS title,
        f.year AS release_year,
        f.poster_url,
        f.is_watched,
        f.position,
        f.created_at,
        f.updated_at,
        f.category_id,
        c.name AS category_name,
        f.subcategory_id,
        sc.name AS subcategory_name,
        f.series_id AS id
      FROM favorites f
      JOIN categories c          ON c.category_id = f.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = f.subcategory_id
      WHERE f.user_id = $1
        AND f.favorite_category = $2
        AND f.series_id IS NOT NULL
      ORDER BY COALESCE(f.position, 999999), f.favorite_id DESC;
    `;

    const countsSql = `
      WITH fm AS (
        SELECT COUNT(*)::int AS movies_cnt
        FROM favorites
        WHERE user_id = $1
          AND favorite_category = $2
          AND movie_id IS NOT NULL
      ),
      fs AS (
        SELECT COUNT(*)::int AS series_cnt
        FROM favorites
        WHERE user_id = $1
          AND favorite_category = $2
          AND series_id IS NOT NULL
      )
      SELECT fm.movies_cnt, fs.series_cnt, (fm.movies_cnt + fs.series_cnt) AS total_cnt
      FROM fm, fs;
    `;

    const [mRes, sRes, cRes] = await Promise.all([
      client.query(moviesSql, [user_id, favorite_category]),
      client.query(seriesSql, [user_id, favorite_category]),
      client.query(countsSql,  [user_id, favorite_category]),
    ]);

    await client.query('COMMIT');

    const counts = cRes.rows[0] || { movies_cnt: 0, series_cnt: 0, total_cnt: 0 };
    return res.json({
      favorite_category,
      counts: {
        movies: counts.movies_cnt,
        series: counts.series_cnt,
        total:  counts.total_cnt
      },
      movies: mRes.rows,
      series: sRes.rows
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('add-and-fetch-category error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});



/* ----------------------- SEARCH (rich details) ----------------------- */
// GET /api/favorites/search?q=...&limit=30&offset=0
router.get('/search', async (req,res)=>{
  try{
    const q = (req.query.q || '').trim();
    if(!q) return res.status(400).json({error:"Missing required query param 'q'."});

    const limit  = Math.min(parseInt(req.query.limit ?? '30',10)||30, 200);
    const offset = Math.max(parseInt(req.query.offset ?? '0',10)||0, 0);

    const like = `%${q}%`;
    const isYear = /^\d{4}$/.test(q);
    const params = [like, like, like, like]; // reused

    // MOVIES with parts + genres
    const moviesQuery = `
      SELECT 
        'movie'::text AS type,
        m.movie_id AS id,
        m.movie_name AS title,
        m.release_year,
        m.category_id,
        c.name AS category_name,
        c.color AS category_color,
        m.subcategory_id,
        sc.name AS subcategory_name,
        m.is_watched,
        m.poster_url,
        m.created_at,
        (
          SELECT array_agg(CONCAT('Part ', mp.part_number, ' (', mp.year, ')') ORDER BY mp.part_number)
          FROM movie_parts mp
          WHERE mp.movie_id = m.movie_id
        ) AS parts,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM movie_genres mg
          JOIN genres g ON g.genre_id = mg.genre_id
          WHERE mg.movie_id = m.movie_id
        ) AS genres
      FROM movies m
      JOIN categories c          ON c.category_id = m.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = m.subcategory_id
      WHERE (
        m.movie_name ILIKE $1
        OR c.name ILIKE $2
        OR (sc.name IS NOT NULL AND sc.name ILIKE $3)
        OR EXISTS (
          SELECT 1 FROM movie_genres mg
          JOIN genres g ON g.genre_id = mg.genre_id
          WHERE mg.movie_id = m.movie_id AND g.name ILIKE $4
        )
        ${isYear ? `OR m.release_year = ${Number(q)}` : ''}
      )
    `;

    // SERIES with seasons + genres
    const seriesQuery = `
      SELECT 
        'series'::text AS type,
        s.series_id AS id,
        s.series_name AS title,
        s.release_year,
        s.category_id,
        c.name AS category_name,
        c.color AS category_color,
        s.subcategory_id,
        sc.name AS subcategory_name,
        s.is_watched,
        s.poster_url,
        s.created_at,
        (
          SELECT array_agg(CONCAT('Season ', se.season_no, ' (', se.year, ')') ORDER BY se.season_no)
          FROM seasons se
          WHERE se.series_id = s.series_id
        ) AS seasons,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM series_genres sg
          JOIN genres g ON g.genre_id = sg.genre_id
          WHERE sg.series_id = s.series_id
        ) AS genres
      FROM series s
      JOIN categories c          ON c.category_id = s.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = s.subcategory_id
      WHERE (
        s.series_name ILIKE $1
        OR c.name ILIKE $2
        OR (sc.name IS NOT NULL AND sc.name ILIKE $3)
        OR EXISTS (
          SELECT 1 FROM series_genres sg
          JOIN genres g ON g.genre_id = sg.genre_id
          WHERE sg.series_id = s.series_id AND g.name ILIKE $4
        )
        ${isYear ? `OR s.release_year = ${Number(q)}` : ''}
      )
    `;

    const unioned = `
      ${moviesQuery}
      UNION ALL
      ${seriesQuery}
      ORDER BY created_at DESC, id DESC
      LIMIT $5::int OFFSET $6::int
    `;

    const { rows } = await db.query(unioned, [...params, limit, offset]);
    return res.json({ count: rows.length, results: rows });
  }catch(err){
    console.error('Search error:', err);
    res.status(500).json({error:'Internal server error'});
  }
});

/* ----------------------- WATCH FILTER (rich details) ----------------------- */
// GET /api/favorites/watch-filter?watched=yes|no|all&limit=20&offset=0
router.get('/watch-filter', async (req,res)=>{
  try{
    const watchedParam = String(req.query.watched || 'all').trim().toLowerCase();
    const limit  = Math.min(parseInt(req.query.limit ?? '20',10)||20, 200);
    const offset = Math.max(parseInt(req.query.offset ?? '0',10)||0, 0);

    let watched = null;
    if (['yes','true','1','watched'].includes(watchedParam)) watched = true;
    else if (['no','false','0','unwatched'].includes(watchedParam)) watched = false;

    // Counts from base tables
    const countsSql = `
      WITH m AS (
        SELECT 
          SUM(CASE WHEN is_watched THEN 1 ELSE 0 END) AS watched,
          SUM(CASE WHEN NOT is_watched THEN 1 ELSE 0 END) AS not_watched,
          COUNT(*) AS total
        FROM movies
      ),
      s AS (
        SELECT 
          SUM(CASE WHEN is_watched THEN 1 ELSE 0 END) AS watched,
          SUM(CASE WHEN NOT is_watched THEN 1 ELSE 0 END) AS not_watched,
          COUNT(*) AS total
        FROM series
      )
      SELECT 
        m.watched  AS movies_watched,
        m.not_watched AS movies_not_watched,
        m.total    AS movies_total,
        s.watched  AS series_watched,
        s.not_watched AS series_not_watched,
        s.total    AS series_total
      FROM m, s;
    `;

    // Movies params & SQL (typed limit/offset)
    const mConds = ['1=1'];
    const mParams = [];
    let mi = 1;
    if (watched !== null){ mConds.push(`m.is_watched = $${mi++}`); mParams.push(watched); }
    const moviesQuery = `
      SELECT 
        'movie'::text AS type,
        m.movie_id AS id,
        m.movie_name AS title,
        m.release_year,
        m.category_id,
        c.name AS category_name,
        c.color AS category_color,
        m.subcategory_id,
        sc.name AS subcategory_name,
        m.is_watched,
        m.poster_url,
        m.created_at,
        (
          SELECT array_agg(CONCAT('Part ', mp.part_number, ' (', mp.year, ')') ORDER BY mp.part_number)
          FROM movie_parts mp
          WHERE mp.movie_id = m.movie_id
        ) AS parts,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM movie_genres mg
          JOIN genres g ON g.genre_id = mg.genre_id
          WHERE mg.movie_id = m.movie_id
        ) AS genres
      FROM movies m
      JOIN categories c          ON c.category_id = m.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = m.subcategory_id
      WHERE ${mConds.join(' AND ')}
      ORDER BY m.created_at DESC, m.movie_id DESC
      LIMIT $${mi++}::int OFFSET $${mi++}::int;
    `;
    mParams.push(limit, offset);

    // Series params & SQL (typed limit/offset)
    const sConds = ['1=1'];
    const sParams = [];
    let si = 1;
    if (watched !== null){ sConds.push(`s.is_watched = $${si++}`); sParams.push(watched); }
    const seriesQuery = `
      SELECT 
        'series'::text AS type,
        s.series_id AS id,
        s.series_name AS title,
        s.release_year,
        s.category_id,
        c.name AS category_name,
        c.color AS category_color,
        s.subcategory_id,
        sc.name AS subcategory_name,
        s.is_watched,
        s.poster_url,
        s.created_at,
        (
          SELECT array_agg(CONCAT('Season ', se.season_no, ' (', se.year, ')') ORDER BY se.season_no)
          FROM seasons se
          WHERE se.series_id = s.series_id
        ) AS seasons,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM series_genres sg
          JOIN genres g ON g.genre_id = sg.genre_id
          WHERE sg.series_id = s.series_id
        ) AS genres
      FROM series s
      JOIN categories c          ON c.category_id = s.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = s.subcategory_id
      WHERE ${sConds.join(' AND ')}
      ORDER BY s.created_at DESC, s.series_id DESC
      LIMIT $${si++}::int OFFSET $${si++}::int;
    `;
    sParams.push(limit, offset);

    const [countsRes, moviesRes, seriesRes] = await Promise.all([
      db.query(countsSql),
      db.query(moviesQuery, mParams),
      db.query(seriesQuery, sParams),
    ]);

    const c = countsRes.rows[0] || {};
    const counts = {
      movies: { watched: Number(c.movies_watched||0), not_watched: Number(c.movies_not_watched||0), total: Number(c.movies_total||0) },
      series: { watched: Number(c.series_watched||0), not_watched: Number(c.series_not_watched||0), total: Number(c.series_total||0) },
    };

    return res.json({
      filters: { watched: watched===null ? 'all' : watched ? 'yes' : 'no' },
      counts,
      movies: moviesRes.rows,
      series: seriesRes.rows,
    });
  }catch(err){
    console.error('Watch-filter error:', err);
    res.status(500).json({error:'Internal server error'});
  }
});

/* ----------------------- CATEGORY FILTER (rich details) ----------------------- */
// GET /api/favorites/category-filter?category=<id-or-name>&limitMovies=20&offsetMovies=0&limitSeries=20&offsetSeries=0
router.get('/category-filter', async (req,res)=>{
  try{
    const raw = (req.query.category || '').trim();
    if(!raw) return res.status(400).json({error:"Missing required 'category' query param (id or name)."});

    const limitMovies  = Math.min(parseInt(req.query.limitMovies ?? '20',10)||20, 200);
    const offsetMovies = Math.max(parseInt(req.query.offsetMovies ?? '0',10)||0, 0);
    const limitSeries  = Math.min(parseInt(req.query.limitSeries ?? '20',10)||20, 200);
    const offsetSeries = Math.max(parseInt(req.query.offsetSeries ?? '0',10)||0, 0);

    const asId = /^\d+$/.test(raw) ? Number(raw) : null;
    const catById   = `SELECT category_id, name FROM categories WHERE category_id = $1`;
    const catByName = `SELECT category_id, name FROM categories WHERE LOWER(name) = LOWER($1)`;
    const catRes = asId ? await db.query(catById,[asId]) : await db.query(catByName,[raw]);
    if(catRes.rowCount===0) return res.status(404).json({error:`Category not found for '${raw}'.`});

    const category = catRes.rows[0];

    const countsSql = `
      WITH m AS (SELECT COUNT(*)::int AS total FROM movies WHERE category_id = $1),
           s AS (SELECT COUNT(*)::int AS total FROM series WHERE category_id = $1)
      SELECT m.total AS movies_total, s.total AS series_total, (m.total + s.total) AS overall_total
      FROM m, s;
    `;

    const moviesQuery = `
      SELECT 
        'movie'::text AS type,
        m.movie_id AS id,
        m.movie_name AS title,
        m.release_year,
        m.category_id,
        c.name AS category_name,
        c.color AS category_color,
        m.subcategory_id,
        sc.name AS subcategory_name,
        m.is_watched,
        m.poster_url,
        m.created_at,
        (
          SELECT array_agg(CONCAT('Part ', mp.part_number, ' (', mp.year, ')') ORDER BY mp.part_number)
          FROM movie_parts mp
          WHERE mp.movie_id = m.movie_id
        ) AS parts,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM movie_genres mg
          JOIN genres g ON g.genre_id = mg.genre_id
          WHERE mg.movie_id = m.movie_id
        ) AS genres
      FROM movies m
      JOIN categories c          ON c.category_id = m.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = m.subcategory_id
      WHERE m.category_id = $1
      ORDER BY m.created_at DESC, m.movie_id DESC
      LIMIT $2::int OFFSET $3::int;
    `;

    const seriesQuery = `
      SELECT 
        'series'::text AS type,
        s.series_id AS id,
        s.series_name AS title,
        s.release_year,
        s.category_id,
        c.name AS category_name,
        c.color AS category_color,
        s.subcategory_id,
        sc.name AS subcategory_name,
        s.is_watched,
        s.poster_url,
        s.created_at,
        (
          SELECT array_agg(CONCAT('Season ', se.season_no, ' (', se.year, ')') ORDER BY se.season_no)
          FROM seasons se
          WHERE se.series_id = s.series_id
        ) AS seasons,
        (
          SELECT array_agg(DISTINCT g.name ORDER BY g.name)
          FROM series_genres sg
          JOIN genres g ON g.genre_id = sg.genre_id
          WHERE sg.series_id = s.series_id
        ) AS genres
      FROM series s
      JOIN categories c          ON c.category_id = s.category_id
      LEFT JOIN subcategories sc ON sc.subcategory_id = s.subcategory_id
      WHERE s.category_id = $1
      ORDER BY s.created_at DESC, s.series_id DESC
      LIMIT $2::int OFFSET $3::int;
    `;

    const [countsRes, moviesRes, seriesRes] = await Promise.all([
      db.query(countsSql, [category.category_id]),
      db.query(moviesQuery, [category.category_id, limitMovies, offsetMovies]),
      db.query(seriesQuery, [category.category_id, limitSeries, offsetSeries]),
    ]);

    const cs = countsRes.rows[0] || {movies_total:0, series_total:0, overall_total:0};
    return res.json({
      category: { id: category.category_id, name: category.name },
      counts: { movies: cs.movies_total, series: cs.series_total, overall: cs.overall_total },
      movies: moviesRes.rows,
      series: seriesRes.rows,
    });
  }catch(err){
    console.error('Category-filter error:', err);
    res.status(500).json({error:'Internal server error'});
  }
});

module.exports = router;
