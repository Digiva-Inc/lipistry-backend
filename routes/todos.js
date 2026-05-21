const express = require("express")
const db = require("../db")
const authenticateAndAuthorize = require("../middleware/authMiddleware");

const router = express.Router()

// Get all todos for the logged-in user
router.get("/read", authenticateAndAuthorize(),  (req, res) => {
  db.query(
    "SELECT * FROM todolist WHERE user_id = ? ORDER BY created_at DESC",
    [req.user.id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      res.json(result);
    }
  );
});

// Add a new todo for the logged-in user
router.post("/insert", authenticateAndAuthorize(), (req, res) => {
  const { title } = req.body;
  db.query(
    "INSERT INTO todolist (title, user_id) VALUES (?, ?)",
    [title, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      res.json({ id: result.insertId, title, is_finished: false });
    }
  );
});

// Update todo title (only if it belongs to the logged-in user)
router.put("/update/:id", authenticateAndAuthorize(), (req, res) => {
  const { id } = req.params;
  const { title } = req.body;

  db.query(
    "UPDATE todolist SET title = ? WHERE id = ? AND user_id = ?",
    [title.trim(), id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      if (result.affectedRows === 0)
        return res.status(404).json({ message: "Todo not found or not yours" });
      res.json({ message: "Todo updated successfully" });
    }
  );
});


// Toggle finished state (only if it belongs to the logged-in user)
router.put("/finish/:id", authenticateAndAuthorize(), (req, res) => {
  const { id } = req.params;
  db.query(
    "UPDATE todolist SET is_finished = NOT is_finished WHERE id = ? AND user_id = ?",
    [id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      if (result.affectedRows === 0)
        return res.status(404).json({ message: "Todo not found or not yours" });
      res.json({ message: "Todo status toggled" });
    }
  );
});

// Delete todo (only if it belongs to the logged-in user)
router.delete("/delete/:id", authenticateAndAuthorize(), (req, res) => {
  const { id } = req.params;
  db.query(
    "DELETE FROM todolist WHERE id = ? AND user_id = ?",
    [id, req.user.id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      if (result.affectedRows === 0)
        return res.status(404).json({ message: "Todo not found or not yours" });
      res.json({ message: "Todo deleted" });
    }
  );
});

module.exports = router;