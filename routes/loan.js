// routes/loan.js
const express = require('express');
const router = express.Router();
const pool = require('../db'); // <- pg Pool instance

/* ---------------------------
   CATEGORY HELPERS & ROUTES
----------------------------*/

// List TOP-LEVEL categories (parent_id IS NULL)
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, category_name, parent_id
         FROM loan_category
        WHERE parent_id IS NULL
        ORDER BY category_name ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// List SUBCATEGORIES for a given parent category id
router.get('/categories/:parentId/subcategories', async (req, res) => {
  const { parentId } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, category_name, parent_id
         FROM loan_category
        WHERE parent_id = $1
        ORDER BY category_name ASC`,
      [parentId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch subcategories' });
  }
});

// Add category OR subcategory (if parent_id provided)
// Body: { name: string, parent_id?: number }
router.post('/categories', async (req, res) => {
  const { name, parent_id } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Category name is required' });
  }
  try {
    // Ensure uniqueness within same parent scope
    const { rows } = await pool.query(
      `INSERT INTO loan_category (category_name, parent_id)
       VALUES ($1, $2)
       ON CONFLICT (category_name) DO NOTHING
       RETURNING id, category_name, parent_id`,
      [name.trim(), parent_id || null]
    );
    if (rows.length) return res.status(201).json(rows[0]);

    // If conflict (existing by unique name), fetch and return existing
    const existing = await pool.query(
      `SELECT id, category_name, parent_id
         FROM loan_category
        WHERE category_name = $1
        LIMIT 1`,
      [name.trim()]
    );
    return res.status(200).json(existing.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to add category' });
  }
});

/* ---------------------------
   LOANS: CRUD
   - category: mandatory (either select or manual)
   - subcategory: optional
   - loan_title: required
   - loan_amount: required
   - loan_get_date: optional
   - extra_details: optional
----------------------------*/

// Get all loans (basic filters optional)
router.get('/loans', async (req, res) => {
  const { search, category, subcategory } = req.query;
  const where = [];
  const vals = [];

  if (search) {
    vals.push(`%${search}%`);
    where.push(`(loan_title ILIKE $${vals.length} OR extra_details ILIKE $${vals.length})`);
  }
  if (category) {
    vals.push(category);
    where.push(`category = $${vals.length}`);
  }
  if (subcategory) {
    vals.push(subcategory);
    where.push(`subcategory = $${vals.length}`);
  }

  const sql = `
    SELECT id, seq_no, category, subcategory, loan_title,
           loan_amount, loan_get_date, extra_details, created_at
      FROM loan_details
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC
  `;

  try {
    const { rows } = await pool.query(sql, vals);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch loans' });
  }
});

// Get loan by id
router.get('/loans/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, seq_no, category, subcategory, loan_title,
              loan_amount, loan_get_date, extra_details, created_at
         FROM loan_details
        WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch loan' });
  }
});

// Add loan
// Body:
// {
//   categorySelect?: number,           // existing category id (top-level) (optional if manualCategory provided)
//   manualCategory?: string,           // manual category text (optional if categorySelect provided)
//   subcategorySelect?: number,        // existing subcategory id (optional)
//   manualSubcategory?: string,        // manual subcategory text (optional)
//   loan_title: string (required),
//   loan_amount: number (required),
//   loan_get_date?: 'YYYY-MM-DD',      // optional
//   extra_details?: string             // optional
// }
router.post('/loans', async (req, res) => {
  try {
    const {
      categorySelect,
      manualCategory,
      subcategorySelect,
      manualSubcategory,
      loan_title,
      loan_amount,
      loan_get_date,
      extra_details,
      seq_no
    } = req.body || {};

    if (!loan_title || !loan_title.trim()) {
      return res.status(400).json({ error: 'loan_title is required' });
    }
    if (loan_amount === undefined || loan_amount === null || isNaN(Number(loan_amount))) {
      return res.status(400).json({ error: 'loan_amount is required and must be a number' });
    }

    // Resolve category text:
    let categoryText = null;

    if (manualCategory && manualCategory.trim()) {
      categoryText = manualCategory.trim();

      // Also store into loan_category if not already there (as top-level)
      await pool.query(
        `INSERT INTO loan_category (category_name, parent_id)
         VALUES ($1, NULL)
         ON CONFLICT (category_name) DO NOTHING`,
        [categoryText]
      );
    } else if (categorySelect) {
      const cat = await pool.query(
        `SELECT category_name FROM loan_category WHERE id = $1`,
        [categorySelect]
      );
      if (!cat.rows.length) return res.status(400).json({ error: 'Invalid categorySelect' });
      categoryText = cat.rows[0].category_name;
    } else {
      return res.status(400).json({ error: 'Category is required (select or manual)' });
    }

    // Resolve optional subcategory text:
    let subcategoryText = null;

    if (manualSubcategory && manualSubcategory.trim()) {
      subcategoryText = manualSubcategory.trim();

      // If we know the chosen/created top-level category id, try to upsert subcategory row under it
      // Find/ensure parent top-level category id:
      const parentCat = await pool.query(
        `SELECT id FROM loan_category WHERE category_name = $1 AND parent_id IS NULL LIMIT 1`,
        [categoryText]
      );
      const parentId = parentCat.rows?.[0]?.id || null;

      if (parentId) {
        await pool.query(
          `INSERT INTO loan_category (category_name, parent_id)
           VALUES ($1, $2)
           ON CONFLICT (category_name) DO NOTHING`,
          [subcategoryText, parentId]
        );
      }
    } else if (subcategorySelect) {
      const sub = await pool.query(
        `SELECT category_name FROM loan_category WHERE id = $1`,
        [subcategorySelect]
      );
      if (!sub.rows.length) return res.status(400).json({ error: 'Invalid subcategorySelect' });
      subcategoryText = sub.rows[0].category_name;
    }

    const insert = await pool.query(
      `INSERT INTO loan_details
         (seq_no, category, subcategory, loan_title, loan_amount, loan_get_date, extra_details)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, seq_no, category, subcategory, loan_title, loan_amount, loan_get_date, extra_details, created_at`,
      [
        seq_no || null,
        categoryText,
        subcategoryText,
        loan_title.trim(),
        Number(loan_amount),
        loan_get_date ? loan_get_date : null,
        extra_details || null
      ]
    );

    res.status(201).json(insert.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to create loan' });
  }
});

// Update loan
// Body can include same fields as POST (any subset)
router.put('/loans/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const {
      categorySelect,
      manualCategory,
      subcategorySelect,
      manualSubcategory,
      loan_title,
      loan_amount,
      loan_get_date,
      extra_details,
      seq_no
    } = req.body || {};

    // Build update fields dynamically
    let categoryText, subcategoryText;

    if (manualCategory && manualCategory.trim()) {
      categoryText = manualCategory.trim();
      await pool.query(
        `INSERT INTO loan_category (category_name, parent_id)
         VALUES ($1, NULL)
         ON CONFLICT (category_name) DO NOTHING`,
        [categoryText]
      );
    } else if (categorySelect) {
      const cat = await pool.query(
        `SELECT category_name FROM loan_category WHERE id = $1`,
        [categorySelect]
      );
      if (!cat.rows.length) return res.status(400).json({ error: 'Invalid categorySelect' });
      categoryText = cat.rows[0].category_name;
    }

    if (manualSubcategory && manualSubcategory.trim()) {
      subcategoryText = manualSubcategory.trim();
      // ensure sub under parent
      const parentCat = await pool.query(
        `SELECT id FROM loan_category WHERE category_name = $1 AND parent_id IS NULL LIMIT 1`,
        [categoryText || null]
      );
      const parentId = parentCat.rows?.[0]?.id || null;
      if (parentId) {
        await pool.query(
          `INSERT INTO loan_category (category_name, parent_id)
           VALUES ($1, $2)
           ON CONFLICT (category_name) DO NOTHING`,
          [subcategoryText, parentId]
        );
      }
    } else if (subcategorySelect) {
      const sub = await pool.query(
        `SELECT category_name FROM loan_category WHERE id = $1`,
        [subcategorySelect]
      );
      if (!sub.rows.length) return res.status(400).json({ error: 'Invalid subcategorySelect' });
      subcategoryText = sub.rows[0].category_name;
    }

    // Prepare update statement
    const fields = [];
    const values = [];
    const push = v => { values.push(v); return `$${values.length}`; };

    if (seq_no !== undefined) fields.push(`seq_no = ${push(seq_no)}`);
    if (categoryText !== undefined) fields.push(`category = ${push(categoryText)}`);
    if (subcategoryText !== undefined) fields.push(`subcategory = ${push(subcategoryText)}`);
    if (loan_title !== undefined) fields.push(`loan_title = ${push(loan_title)}`);
    if (loan_amount !== undefined) fields.push(`loan_amount = ${push(Number(loan_amount))}`);
    if (loan_get_date !== undefined) fields.push(`loan_get_date = ${push(loan_get_date || null)}`);
    if (extra_details !== undefined) fields.push(`extra_details = ${push(extra_details)}`);

    if (!fields.length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    values.push(id);
    const sql = `
      UPDATE loan_details
         SET ${fields.join(', ')}
       WHERE id = $${values.length}
       RETURNING id, seq_no, category, subcategory, loan_title, loan_amount, loan_get_date, extra_details, created_at
    `;

    const { rows } = await pool.query(sql, values);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update loan' });
  }
});

// Delete loan
router.delete('/loans/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM loan_details WHERE id = $1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to delete loan' });
  }
});

module.exports = router;
