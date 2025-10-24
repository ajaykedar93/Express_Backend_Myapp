// routes/download.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

/* ============================
   Small utilities
============================ */
function parseBoolLoose(val) {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const v = val.toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }
  return false;
}

function stripNonAscii(s) {
  return (s ?? "").replace(/[^\x00-\x7F]/g, "");
}
function pickCategoryColor(item) {
  const hex = (item.category_color || item.categoryColor || item.color || "").toString();
  const m = hex.trim().match(/^#?[0-9a-fA-F]{6}$/);
  return m ? (hex.startsWith("#") ? hex : `#${hex}`) : null;
}
function hexToARGB(hex) {
  if (!hex) return "FFFFFFFF";
  const h = hex.replace("#", "").toUpperCase();
  return `FF${h}`;
}
function addPageIfNeeded(doc, nextBoxBottomY, margin) {
  const pageHeight = doc.page.height;
  if (nextBoxBottomY > pageHeight - margin) {
    doc.addPage();
    return margin;
  }
  return null;
}

/* ============================================================
   GET /api/download
   Fetch Movies + Series (filters supported) — parameterized
============================================================ */
router.get("/", async (req, res) => {
  const { search = "", category_id = "", is_watched = "" } = req.query;

  // Movies
  const mConds = ["1=1"];
  const mParams = [];
  if (search) {
    mParams.push(`%${search}%`);
    mConds.push(`m.movie_name ILIKE $${mParams.length}`);
  }
  if (category_id) {
    mParams.push(Number(category_id));
    mConds.push(`m.category_id = $${mParams.length}`);
  }
  if (is_watched !== "") {
    mParams.push(parseBoolLoose(is_watched));
    mConds.push(`m.is_watched = $${mParams.length}`);
  }

  const moviesQuery = `
    SELECT 
      m.movie_id,
      m.movie_name,
      m.release_year,
      c.name AS category_name,
      c.color AS category_color,
      sc.name AS subcategory_name,
      m.is_watched,
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
    JOIN categories c ON c.category_id = m.category_id
    LEFT JOIN subcategories sc ON sc.subcategory_id = m.subcategory_id
    WHERE ${mConds.join(" AND ")}
    ORDER BY m.created_at DESC;
  `;

  // Series
  const sConds = ["1=1"];
  const sParams = [];
  if (search) {
    sParams.push(`%${search}%`);
    sConds.push(`s.series_name ILIKE $${sParams.length}`);
  }
  if (category_id) {
    sParams.push(Number(category_id));
    sConds.push(`s.category_id = $${sParams.length}`);
  }
  if (is_watched !== "") {
    sParams.push(parseBoolLoose(is_watched));
    sConds.push(`s.is_watched = $${sParams.length}`);
  }

  const seriesQuery = `
    SELECT 
      s.series_id,
      s.series_name,
      s.release_year,
      c.name AS category_name,
      c.color AS category_color,
      sc.name AS subcategory_name,
      s.is_watched,
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
    JOIN categories c ON c.category_id = s.category_id
    LEFT JOIN subcategories sc ON sc.subcategory_id = s.subcategory_id
    WHERE ${sConds.join(" AND ")}
    ORDER BY s.created_at DESC;
  `;

  try {
    const client = await db.connect();
    const [moviesResult, seriesResult] = await Promise.all([
      client.query(moviesQuery, mParams),
      client.query(seriesQuery, sParams),
    ]);
    client.release();

    res.json({
      movies: moviesResult.rows,
      series: seriesResult.rows,
    });
  } catch (err) {
    console.error("Error in GET /api/download:", err);
    res.status(500).json({ error: "Failed to fetch movies/series" });
  }
});

/* ============================================================
   POST /api/download/export
   Export Movies/Series list (pdf | excel | txt)
============================================================ */
router.post("/export", async (req, res) => {
  const { items, type } = req.body;

  if (!items || items.length === 0) {
    return res.status(400).json({ error: "No items selected" });
  }

  try {
    // Normalize/Clean
    const cleanItems = items.map((raw) => {
      const genres =
        Array.isArray(raw.genres) ? raw.genres.map(stripNonAscii) :
        Array.isArray(raw.genre)  ? raw.genre.map(stripNonAscii)  : [];
      const parts   = Array.isArray(raw.parts)   ? raw.parts.map(stripNonAscii)   : [];
      const seasons = Array.isArray(raw.seasons) ? raw.seasons.map(stripNonAscii) : [];

      return {
        ...raw,
        movie_name: stripNonAscii(raw.movie_name),
        series_name: stripNonAscii(raw.series_name),
        category_name: stripNonAscii(raw.category_name),
        release_year: raw.release_year ?? "",
        is_watched: !!raw.is_watched,
        genres,
        parts,
        seasons,
        _category_hex: pickCategoryColor(raw),
      };
    });

    const movies = cleanItems.filter((i) => !!i.movie_name);
    const series = cleanItems.filter((i) => !!i.series_name);

    // ---------- PDF ----------
    if (type === "pdf") {
      const margin = 36;
      const cardH = 84;
      const gap = 10;
      const doc = new PDFDocument({ margin, size: "A4" });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=movies_series.pdf");
      doc.pipe(res);

      let y = margin;
      doc.font("Helvetica-Bold").fontSize(18).text("Export: Movies & Series", { align: "left" });
      y += 28;

      const renderSection = (title, list, isMovie) => {
        if (!list.length) return;

        doc.font("Helvetica-Bold").fontSize(14).fillColor("#111111").text(title, margin, y);
        y += 10;

        doc
          .moveTo(margin, y)
          .lineTo(doc.page.width - margin, y)
          .lineWidth(0.6)
          .strokeColor("#DDDDDD")
          .stroke();
        y += 12;

        let idx = 1;
        for (const item of list) {
          const nextBottom = y + cardH;
          const resetY = addPageIfNeeded(doc, nextBottom, margin);
          if (resetY !== null) {
            y = resetY;
            doc.font("Helvetica-Bold").fontSize(14).fillColor("#111111").text(title, margin, y);
            y += 10;
            doc
              .moveTo(margin, y)
              .lineTo(doc.page.width - margin, y)
              .lineWidth(0.6)
              .strokeColor("#DDDDDD")
              .stroke();
            y += 12;
          }

          const cardX = margin;
          const cardW = doc.page.width - margin * 2;
          const borderColor = item._category_hex || "#B9C3CF";

          if (item._category_hex) {
            doc.save();
            doc.fillColor(item._category_hex, 0.06);
            doc.rect(cardX, y, cardW, cardH).fill();
            doc.restore();
          }

          doc
            .lineWidth(1)
            .strokeColor(borderColor)
            .rect(cardX, y, cardW, cardH)
            .stroke();

          const badgeW = 26;
          doc
            .save()
            .fillColor(borderColor)
            .rect(cardX, y, badgeW, cardH)
            .fill()
            .restore();

          doc
            .fillColor("#FFFFFF")
            .font("Helvetica-Bold")
            .fontSize(12)
            .text(String(idx), cardX, y + (cardH / 2 - 7), { width: badgeW, align: "center" });

          const pad = 10;
          let tx = cardX + badgeW + pad;
          let ty = y + 10;

          const nameLine = isMovie
            ? `${item.movie_name || "-"}${item.release_year ? ` (${item.release_year})` : ""}`
            : `${item.series_name || "-"}${item.release_year ? ` (${item.release_year})` : ""}`;

          doc.font("Helvetica-Bold").fontSize(12).fillColor("#111111").text(nameLine, tx, ty, {
            width: cardW - badgeW - pad * 2,
            ellipsis: true,
          });

          ty += 18;
          doc.font("Helvetica").fontSize(10).fillColor("#333333");
          doc.text(`Category: ${item.category_name || "-"}`, tx, ty);
          ty += 14;
          doc.text(`Genres: ${item.genres?.length ? item.genres.join(", ") : "-"}`, tx, ty);
          ty += 14;

          if (isMovie) {
            doc.text(`Parts: ${item.parts?.length ? item.parts.join(", ") : "Part 1"}`, tx, ty);
          } else {
            doc.text(`Seasons: ${item.seasons?.length ? item.seasons.join(", ") : "Season 1"}`, tx, ty);
          }

          const watchedText = item.is_watched ? "Watched: Yes" : "Watched: No";
          doc
            .font("Helvetica-Bold")
            .fontSize(10)
            .fillColor(item.is_watched ? "#0B7A3B" : "#8A1C1C")
            .text(watchedText, cardX + cardW - 110, y + cardH - 18, { width: 100, align: "right" });

          y += cardH + gap;
          idx++;
        }

        y += 6;
      };

      renderSection("Movies", movies, true);
      renderSection("Series", series, false);

      doc.end();
      return;
    }

    // ---------- Excel ----------
    if (type === "excel") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Movies_Series", { views: [{ state: "frozen", ySplit: 1 }] });

      sheet.columns = [
        { header: "No",          key: "no",         width: 6 },
        { header: "Name",        key: "name",       width: 42 },
        { header: "Category",    key: "category",   width: 20 },
        { header: "Subcategory", key: "subcat",     width: 14 },
        { header: "Genre",       key: "genre",      width: 36 },
        { header: "Part/Season", key: "part",       width: 18 },
        { header: "Year",        key: "year",       width: 10 },
        { header: "Watched",     key: "watched",    width: 10 },
      ];

      sheet.getRow(1).font = { bold: true };
      sheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
      sheet.getRow(1).height = 20;

      let rowNo = 1;
      for (const item of cleanItems) {
        const sub = item.movie_name ? "Movies" : "Series";
        const row = sheet.addRow({
          no: rowNo++,
          name: item.movie_name || item.series_name || "-",
          category: item.category_name || "-",
          subcat: sub,
          genre: item.genres?.length ? item.genres.join(", ") : "-",
          part: (item.parts?.length ? item.parts.join(", ")
                : item.seasons?.length ? item.seasons.join(", ")
                : sub === "Movies" ? "Part 1" : "Season 1"),
          year: item.release_year || "-",
          watched: item.is_watched ? "Yes" : "No",
        });

        row.eachCell((cell) => {
          cell.border = {
            top: { style: "thin", color: { argb: "FFDDDDDD" } },
            left: { style: "thin", color: { argb: "FFDDDDDD" } },
            bottom: { style: "thin", color: { argb: "FFDDDDDD" } },
            right: { style: "thin", color: { argb: "FFDDDDDD" } },
          };
          cell.alignment = { vertical: "middle", wrapText: true };
        });

        const catColorARGB = hexToARGB(item._category_hex);
        const catCell = row.getCell("category");
        catCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: catColorARGB } };

        if (item._category_hex) {
          const hx = item._category_hex.replace("#", "");
          const r = parseInt(hx.slice(0, 2), 16);
          const g = parseInt(hx.slice(2, 4), 16);
          const b = parseInt(hx.slice(4, 6), 16);
          const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          catCell.font = { color: { argb: luminance < 140 ? "FFFFFFFF" : "FF111111" } };
        }
      }

      sheet.columns.forEach((col) => {
        let max = 0;
        col.eachCell({ includeEmpty: true }, (cell) => {
          const v = cell.value ? cell.value.toString() : "";
          max = Math.max(max, v.length);
        });
        col.width = Math.min(Math.max(col.width || 10, Math.min(max + 2, 60)), 60);
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", "attachment; filename=movies_series.xlsx");
      await workbook.xlsx.write(res);
      res.end();
      return;
    }

    // ---------- TXT ----------
    if (type === "txt") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=movies_series.txt");

      let out = "";
      out += "No | Name | Category | Subcategory | Genre | Part/Season | Year | Watched\n";
      out += "-----------------------------------------------------------------------------\n";

      let rowNo = 1;
      for (const item of cleanItems) {
        const sub = item.movie_name ? "Movies" : "Series";
        const name = item.movie_name || item.series_name || "-";
        const genre = item.genres?.length ? item.genres.join(", ") : "-";
        const part = (item.parts?.length ? item.parts.join(", ")
                    : item.seasons?.length ? item.seasons.join(", ")
                    : sub === "Movies" ? "Part 1" : "Season 1");
        const year = item.release_year || "-";
        const watched = item.is_watched ? "Yes" : "No";

        out += `${rowNo++} | ${name} | ${item.category_name || "-"} | ${sub} | ${genre} | ${part} | ${year} | ${watched}\n`;
      }

      return res.send(out);
    }

    return res.status(400).json({ error: "Invalid export type" });
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Error exporting data" });
  }
});

/* ============================================================
   GET /api/download/categories
============================================================ */
router.get("/categories", async (_req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT category_id, name, color FROM categories ORDER BY name;"
    );
    res.json({ categories: rows });
  } catch (error) {
    console.error("Error fetching categories:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
