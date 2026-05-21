const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

// Helper to wrap db.query
const query = (sql, params) => new Promise((resolve, reject) => {
  db.query(sql, params, (err, result) => {
    if (err) reject(err); else resolve(result);
  });
});

// Create Purchase (Header Only or with items)
router.post("/create", authenticateAndAuthorize(), async (req, res) => {
  const { date, bill_no, party_name, vehicle_no, driver_name, driver_number, transporter_name, lr_number, items, status } = req.body;

  if (!date || !bill_no || !driver_name) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    const basicProductCode = (items && items.length > 0) ? items[0].product_code : "";
    const basicQuantity = (items && items.length > 0) ? items[0].quantity : 0;
    const created_by = req.user.name;

    const insertQuery = "INSERT INTO purchase (date, bill_no, party_name, vehicle_no, driver_name, driver_number, transporter_name, lr_number, product_code, quantity, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const purchaseResult = await query(insertQuery, [date, bill_no, party_name || null, vehicle_no || "", driver_name, driver_number || "", transporter_name || "", lr_number || "", basicProductCode, basicQuantity, created_by, status || "pending"]);
    const purchaseId = purchaseResult.insertId;

    if (items && items.length > 0) {
      for (const item of items) {
        const parsedQuantity = parseInt(item.quantity, 10);

        const insertItemQuery = "INSERT INTO purchase_items (purchase_id, product_code, product_name, gradation, quantity) VALUES (?, ?, ?, ?, ?)";
        await query(insertItemQuery, [purchaseId, item.product_code, item.product_name, item.gradation, parsedQuantity]);

        if (status === "stock_in" || status === "completed") {
          const updateProductQuery = `
           UPDATE product
           SET quantity = quantity + ?
           WHERE product_code = ?
           `;

          await query(updateProductQuery, [
            parsedQuantity,
            item.product_code
          ]);
        }
      }
    }

    res.json({ success: true, message: "Purchase created successfully", insertedId: purchaseId });
  } catch (err) {
    console.error("Purchase Insert Error:", err);
    res.status(500).json({ success: false, message: "Insert Error", error: err.message });
  }
});

// Add Single Item to existing Purchase
router.post("/add-item/:id", authenticateAndAuthorize(), async (req, res) => {
  const purchaseId = req.params.id;
  const { product_code, product_name, gradation, quantity } = req.body;

  if (!product_code || !quantity) {
    return res.status(400).json({ success: false, message: "Product and Quantity are required" });
  }

  try {
    const parsedQuantity = parseInt(quantity, 10);

    // Insert into items
    const insertItemQuery = "INSERT INTO purchase_items (purchase_id, product_code, product_name, gradation, quantity) VALUES (?, ?, ?, ?, ?)";
    await query(insertItemQuery, [purchaseId, product_code, product_name, gradation, parsedQuantity]);

    // Add to main stock
    const updateProductQuery = "UPDATE product SET quantity = quantity + ? WHERE product_code = ?";
    await query(updateProductQuery, [parsedQuantity, product_code]);

    res.json({ success: true, message: "Item added successfully" });
  } catch (err) {
    console.error("Item Insert Error:", err);
    res.status(500).json({ success: false, message: "Item Insert Error", error: err.message });
  }
});

// Update Purchase
router.put("/update/:id", authenticateAndAuthorize(), async (req, res) => {
  const purchaseId = req.params.id;
  const { date, bill_no, party_name, vehicle_no, driver_name, driver_number, transporter_name, lr_number, items } = req.body;

  const itemsToProcess = items || [];

  if (!date || !bill_no || !driver_name) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    // 1. Fetch current (old) items to calculate Virtual Stock
    const oldItems = await query("SELECT * FROM purchase_items WHERE purchase_id = ?", [purchaseId]);

    const oldQuantityMap = {};
    for (const old of oldItems) {
      oldQuantityMap[old.product_code] = (oldQuantityMap[old.product_code] || 0) + old.quantity;
    }

    // 2. Validate new items (Purchases subtract from Virtual Stock to ensure we don't accidentally drop below zero if we deduct an old purchase)
    const aggregatedNewQuantities = {};
    for (const item of itemsToProcess) {
      const q = parseInt(item.quantity, 10) || 0;
      aggregatedNewQuantities[item.product_code] = (aggregatedNewQuantities[item.product_code] || 0) + q;
    }

    for (const code in aggregatedNewQuantities) {
      const totalNewQty = aggregatedNewQuantities[code];
      const stockResult = await query("SELECT quantity FROM product WHERE product_code = ?", [code]);

      if (stockResult.length !== 0) {
        const actualStock = stockResult[0].quantity;
        const removingStock = oldQuantityMap[code] || 0;
        const virtualStock = actualStock - removingStock;

        if (virtualStock + totalNewQty < 0) {
          return res.status(400).json({ success: false, message: `Cannot update purchase. Replacing this order would push ${code} stock below 0.` });
        }
      }
    }

    // --- Validation Passed. Proceed with Mutations. ---

    // 3. Revert old stock values
    for (const old of oldItems) {
      await query("UPDATE product SET quantity = quantity - ? WHERE product_code = ?", [old.quantity, old.product_code]);
    }

    // 4. Clear old items
    await query("DELETE FROM purchase_items WHERE purchase_id = ?", [purchaseId]);

    // 5. Update main record
    const basicProductCode = itemsToProcess[0]?.product_code || "";
    const basicQuantity = itemsToProcess[0]?.quantity || 0;
    await query(
      "UPDATE purchase SET date=?, bill_no=?, party_name=?, vehicle_no=?, driver_name=?, driver_number=?, transporter_name=?, lr_number=?, product_code=?, quantity=? WHERE id=?",
      [date, bill_no, party_name || null, vehicle_no || "", driver_name, driver_number || "", transporter_name || "", lr_number || "", basicProductCode, basicQuantity, purchaseId]
    );

    // 6. Insert new items & add to stock
    for (const item of itemsToProcess) {
      const parsedQuantity = parseInt(item.quantity, 10);
      await query(
        "INSERT INTO purchase_items (purchase_id, product_code, product_name, gradation, quantity) VALUES (?, ?, ?, ?, ?)",
        [purchaseId, item.product_code, item.product_name, item.gradation, parsedQuantity]
      );
      await query("UPDATE product SET quantity = quantity + ? WHERE product_code = ?", [parsedQuantity, item.product_code]);
    }

    res.json({ success: true, message: "Purchase updated successfully" });
  } catch (err) {
    console.error("Purchase Update Error:", err);
    res.status(500).json({ success: false, message: "Update Error", error: err.message });
  }
});

// Delete Purchase
router.delete("/delete/:id", authenticateAndAuthorize(), async (req, res) => {
  const purchaseId = req.params.id;

  try {
    // 1. Fetch items and aggregate by product code to validate stock deletion BEFORE executing
    const oldItems = await query("SELECT * FROM purchase_items WHERE purchase_id = ?", [purchaseId]);

    const aggregatedOldQuantities = {};
    for (const old of oldItems) {
      aggregatedOldQuantities[old.product_code] = (aggregatedOldQuantities[old.product_code] || 0) + old.quantity;
    }

    // Check if reverting this purchase will drop stock below zero
    for (const code in aggregatedOldQuantities) {
      const totalOldQty = aggregatedOldQuantities[code];
      const stockResult = await query("SELECT quantity FROM product WHERE product_code = ?", [code]);
      if (stockResult.length > 0) {
        if (stockResult[0].quantity - totalOldQty < 0) {
          return res.status(400).json({ success: false, message: `Cannot delete purchase. Product ${code} has already been sold. Deleting this would push stock to negative.` });
        }
      }
    }

    // 2. Revert stock
    for (const old of oldItems) {
      await query("UPDATE product SET quantity = quantity - ? WHERE product_code = ?", [old.quantity, old.product_code]);
    }

    // 2. Delete from DB 
    await query("DELETE FROM purchase WHERE id = ?", [purchaseId]);
    // Optionally clean up purchase_items if NO CASCADE is set
    await query("DELETE FROM purchase_items WHERE purchase_id = ?", [purchaseId]);

    res.json({ success: true, message: "Purchase deleted successfully" });
  } catch (err) {
    console.error("Purchase Delete Error:", err);
    res.status(500).json({ success: false, message: "Delete Error", error: err.message });
  }
});

// Get All Purchases
router.get("/read", authenticateAndAuthorize(), (req, res) => {
  const getQuery = `
    SELECT p.*,
           (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = p.id) as items_count
    FROM purchase p 
    ORDER BY p.id DESC
  `;
  db.query(getQuery, (err, purchaseResults) => {
    if (err) return res.status(500).json({ success: false, message: "DB Error", error: err.message });

    const itemsQuery = "SELECT * FROM purchase_items";
    db.query(itemsQuery, (err2, itemResults) => {
      if (err2) return res.status(500).json({ success: false, message: "DB Items Error", error: err2.message });

      const purchasesWithItems = purchaseResults.map(p => ({
        ...p,
        items: itemResults.filter(i => i.purchase_id === p.id)
      }));
      res.json({ success: true, data: purchasesWithItems });
    });
  });
});

router.put("/update-status/:id", authenticateAndAuthorize(), async (req, res) => {
    const purchaseId = req.params.id;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    try {
      // Get old purchase
      const purchaseResult = await query(
        "SELECT * FROM purchase WHERE id = ?",
        [purchaseId]
      );

      if (purchaseResult.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Purchase not found",
        });
      }

      const purchase = purchaseResult[0];
      const oldStatus = purchase.status;

      // Get purchase items
      const items = await query(
        "SELECT * FROM purchase_items WHERE purchase_id = ?",
        [purchaseId]
      );

      // =========================
      // STOCK LOGIC
      // =========================

      // pending -> stock_in/completed
      if (
        oldStatus === "pending" &&
        (status === "stock_in" || status === "completed")
      ) {
        for (const item of items) {
          await query(
            "UPDATE product SET quantity = quantity + ? WHERE product_code = ?",
            [item.quantity, item.product_code]
          );
        }
      }

      // stock_in/completed -> pending
      if (
        (oldStatus === "stock_in" || oldStatus === "completed") &&
        status === "pending"
      ) {
        for (const item of items) {
          await query(
            "UPDATE product SET quantity = quantity - ? WHERE product_code = ?",
            [item.quantity, item.product_code]
          );
        }
      }

      // Update status
      await query(
        "UPDATE purchase SET status = ? WHERE id = ?",
        [status, purchaseId]
      );

      res.json({
        success: true,
        message: "Purchase status updated successfully",
      });
    } catch (err) {
      console.error("Status Update Error:", err);

      res.status(500).json({
        success: false,
        message: "Status Update Error",
        error: err.message,
      });
    }
  }
);

module.exports = router;
