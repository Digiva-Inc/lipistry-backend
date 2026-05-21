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

// Create Sale
router.post("/create", authenticateAndAuthorize(), async (req, res) => {
  const { date, bill_no, customer_name, vehicle_no, driver_name, driver_number, transporter_name, lr_number, items, status } = req.body;

  if (!date || !bill_no || !customer_name || !driver_name) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    const itemsToProcess = items || [];

    // 1. Initial manual check for stock
    const aggregatedQuantities = {};
    for (const item of itemsToProcess) {
      const q = parseInt(item.quantity, 10) || 0;
      aggregatedQuantities[item.product_code] = (aggregatedQuantities[item.product_code] || 0) + q;
    }

    for (const code in aggregatedQuantities) {
      const totalNeeded = aggregatedQuantities[code];
      const stockResult = await query("SELECT quantity, product_name FROM product WHERE product_code = ?", [code]);
      
      if (stockResult.length === 0) {
          return res.status(400).json({ success: false, message: `Product ${code} missing in DB` });
      }

      if (stockResult[0].quantity < totalNeeded) {
          return res.status(400).json({ success: false, message: `Insufficient stock for product ${stockResult[0].product_name} (${code})! Available: ${stockResult[0].quantity}, Required: ${totalNeeded}` });
      }
    }

    const basicProductCode = itemsToProcess[0]?.product_code || "";
    const basicQuantity = itemsToProcess[0]?.quantity || 0;
    const created_by = req.user.name;

    const insertQuery = "INSERT INTO sales (date, bill_no, customer_name, vehicle_no, driver_name, driver_number, transporter_name, lr_number, product_code, quantity, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const insertResult = await query(insertQuery, [date, bill_no, customer_name, vehicle_no || "", driver_name, driver_number || "", transporter_name || "", lr_number || "", basicProductCode, basicQuantity, created_by, status || "pending"]);
    const salesId = insertResult.insertId;

    for (const item of itemsToProcess) {
      const parsedQuantity = parseInt(item.quantity, 10);
      
      const insertItemQuery = "INSERT INTO sales_items (sales_id, product_code, product_name, gradation, quantity) VALUES (?, ?, ?, ?, ?)";
      await query(insertItemQuery, [salesId, item.product_code, item.product_name, item.gradation, parsedQuantity]);
      
      // Update product quantity by subtracting the sold stock
      const updateProductQuery = "UPDATE product SET quantity = quantity - ? WHERE product_code = ?";
      await query(updateProductQuery, [parsedQuantity, item.product_code]);
    }

    res.json({ success: true, message: "Sale recorded successfully", insertedId: salesId });
  } catch (err) {
    console.error("Sales Insert Error:", err);
    res.status(500).json({ success: false, message: "Insert Error", error: err.message });
  }
});

// Update Sale
router.put("/update/:id", authenticateAndAuthorize(), async (req, res) => {
  const saleId = req.params.id;
  const { date, bill_no, customer_name, vehicle_no, driver_name, driver_number, transporter_name, lr_number, items } = req.body;

  const itemsToProcess = items || [];

  if (!date || !bill_no || !customer_name || !driver_name) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    // 1. Fetch current (old) items to calculate Virtual Stock
    const oldItems = await query("SELECT * FROM sales_items WHERE sales_id = ?", [saleId]);
    
    // Create a map to quickly look up old quantities to simulate returning items to stock
    const oldQuantityMap = {};
    for (const old of oldItems) {
       oldQuantityMap[old.product_code] = (oldQuantityMap[old.product_code] || 0) + old.quantity;
    }

    // 2. Validate new items mathematically against Virtual Stock (Actual Stock + Old Quantity)
    const aggregatedNewQuantities = {};
    for (const item of itemsToProcess) {
      const q = parseInt(item.quantity, 10) || 0;
      aggregatedNewQuantities[item.product_code] = (aggregatedNewQuantities[item.product_code] || 0) + q;
    }

    for (const code in aggregatedNewQuantities) {
      const totalNeeded = aggregatedNewQuantities[code];
      const stockResult = await query("SELECT quantity FROM product WHERE product_code = ?", [code]);
      
      if (stockResult.length === 0) {
         return res.status(400).json({ success: false, message: `Product ${code} not found.` });
      }
      
      const actualStock = stockResult[0].quantity;
      const returningStock = oldQuantityMap[code] || 0;
      const virtualStock = actualStock + returningStock;

      if (virtualStock < totalNeeded) {
         return res.status(400).json({ success: false, message: `Insufficient stock for ${code}. Available: ${actualStock} (Would be ${virtualStock} after replacing old dispatch). Required: ${totalNeeded}.` });
      }
    }

    // --- Validation Passed. Proceed with DB Mutations. ---

    // 3. Restock old items safely
    for (const old of oldItems) {
      await query("UPDATE product SET quantity = quantity + ? WHERE product_code = ?", [old.quantity, old.product_code]);
    }

    // 3. Clear old items
    await query("DELETE FROM sales_items WHERE sales_id = ?", [saleId]);

    // 4. Update main record
    const basicProductCode = itemsToProcess[0]?.product_code || "";
    const basicQuantity = itemsToProcess[0]?.quantity || 0;
    await query(
      "UPDATE sales SET date=?, bill_no=?, customer_name=?, vehicle_no=?, driver_name=?, driver_number=?, transporter_name=?, lr_number=?, product_code=?, quantity=? WHERE id=?",
      [date, bill_no, customer_name, vehicle_no || "", driver_name, driver_number || "", transporter_name || "", lr_number || "", basicProductCode, basicQuantity, saleId]
    );

    // 5. Insert new items & decrement stock
    for (const item of itemsToProcess) {
      const parsedQuantity = parseInt(item.quantity, 10);
      await query(
        "INSERT INTO sales_items (sales_id, product_code, product_name, gradation, quantity) VALUES (?, ?, ?, ?, ?)",
        [saleId, item.product_code, item.product_name, item.gradation, parsedQuantity]
      );
      await query("UPDATE product SET quantity = quantity - ? WHERE product_code = ?", [parsedQuantity, item.product_code]);
    }

    res.json({ success: true, message: "Sale updated successfully" });
  } catch (err) {
    console.error("Sale Update Error:", err);
    res.status(500).json({ success: false, message: "Update Error", error: err.message });
  }
});

// Delete Sale
router.delete("/delete/:id", authenticateAndAuthorize(), async (req, res) => {
  const saleId = req.params.id;
  
  try {
    // 1. Revert stock (add back to inventory)
    const oldItems = await query("SELECT * FROM sales_items WHERE sales_id = ?", [saleId]);
    for (const old of oldItems) {
      await query("UPDATE product SET quantity = quantity + ? WHERE product_code = ?", [old.quantity, old.product_code]);
    }

    // 2. Delete from DB
    await query("DELETE FROM sales WHERE id = ?", [saleId]);
    
    res.json({ success: true, message: "Sale deleted successfully" });
  } catch (err) {
    console.error("Sale Delete Error:", err);
    res.status(500).json({ success: false, message: "Delete Error", error: err.message });
  }
});

// Get All Sales
router.get("/read", authenticateAndAuthorize(), (req, res) => {
  const getQuery = `
    SELECT s.*,
           (SELECT COUNT(*) FROM sales_items si WHERE si.sales_id = s.id) as items_count
    FROM sales s 
    ORDER BY s.id DESC
  `;
  db.query(getQuery, (err, salesResults) => {
    if (err) return res.status(500).json({ success: false, message: "DB Error", error: err.message });
    
    const itemsQuery = "SELECT * FROM sales_items";
    db.query(itemsQuery, (err2, itemResults) => {
      if (err2) return res.status(500).json({ success: false, message: "DB Items Error", error: err2.message });
      
      const salesWithItems = salesResults.map(s => ({
        ...s,
        items: itemResults.filter(i => i.sales_id === s.id)
      }));
      res.json({ success: true, data: salesWithItems });
    });
  });
});


router.put("/update-status/:id", authenticateAndAuthorize(), async (req, res) => {
  const salesId = req.params.id;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({
      success: false,
      message: "Status is required",
    });
  }

  try {
    // Get old sale
    const salesResult = await query(
      "SELECT * FROM sales WHERE id = ?",
      [salesId]
    );

    if (salesResult.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Sale not found",
      });
    }

    const sale = salesResult[0];
    const oldStatus = sale.status;

    // Get sale items
    const items = await query(
      "SELECT * FROM sales_items WHERE sales_id = ?",
      [salesId]
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
          "UPDATE product SET quantity = quantity - ? WHERE product_code = ?",
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
          "UPDATE product SET quantity = quantity + ? WHERE product_code = ?",
          [item.quantity, item.product_code]
        );
      }
    }

    // Update status
    await query(
      "UPDATE sales SET status = ? WHERE id = ?",
      [status, salesId]
    );

    res.json({
      success: true,
      message: "Sales status updated successfully",
    });
  } catch (err) {
    console.error("Status Update Error:", err);

    res.status(500).json({
      success: false,
      message: "Status Update Error",
      error: err.message,
    });
  }
});

module.exports = router;
